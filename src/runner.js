import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import chalk from 'chalk';
import ora from 'ora';
import treeKill from 'tree-kill';
import { 
  CONDUCTOR_DIR, STATE_FILE, LOGS_DIR, 
  validatePlan, DEFAULTS, MODEL_UPGRADE_PATH 
} from './schema.js';
import { computeParallelGroups } from './planner.js';
import { createWorktree, mergeWorktree, isGitRepo, getCurrentBranch, removeWorktree } from './worktree.js';

// In-memory state of running processes
const processes = new Map(); // taskId -> ChildProcess

/**
 * Load or initialize the state file
 */
function loadState() {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  }
  return { tasks: {}, started_at: new Date().toISOString(), base_branch: null };
}

function saveState(state) {
  mkdirSync(CONDUCTOR_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Build the CLI arguments for a single Claude Code instance
 */
function buildClaudeArgs(task) {
  const args = [
    '-p', task.prompt,
    '--model', task.model || 'sonnet',
    '--max-turns', String(task.max_turns || DEFAULTS.max_turns),
  ];

  // Permission mode
  if (task.permission_mode === 'plan') {
    args.push('--permission-mode', 'plan');
  } else {
    // acceptEdits or execute → skip permissions for headless
    args.push('--dangerously-skip-permissions');
  }

  // Budget limit
  if (task.max_budget_usd) {
    args.push('--max-budget-usd', String(task.max_budget_usd));
  }

  // Extra system prompt context
  if (task.system_prompt_append) {
    args.push('--append-system-prompt', task.system_prompt_append);
  }

  return args;
}

/**
 * Run a single task as a child process
 */
function runTask(task, cwd, state) {
  return new Promise((resolve) => {
    const args = buildClaudeArgs(task);
    const logFile = join(LOGS_DIR, `${task.id}.log`);

    // Update state
    state.tasks[task.id] = {
      id: task.id,
      status: 'running',
      pid: null,
      started_at: new Date().toISOString(),
      retries: state.tasks[task.id]?.retries || 0,
      current_model: task.model,
      worktree_branch: null,
      error: null,
    };
    saveState(state);

    // Log the command being executed
    const cmdStr = `claude ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`;
    appendFileSync(logFile, `\n${'═'.repeat(60)}\n`);
    appendFileSync(logFile, `Task: ${task.name} (${task.id})\n`);
    appendFileSync(logFile, `Started: ${new Date().toISOString()}\n`);
    appendFileSync(logFile, `Command: ${cmdStr}\n`);
    appendFileSync(logFile, `CWD: ${cwd}\n`);
    appendFileSync(logFile, `${'═'.repeat(60)}\n\n`);

    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    state.tasks[task.id].pid = proc.pid;
    saveState(state);
    processes.set(task.id, proc);

    // Capture output to log file
    proc.stdout.on('data', (data) => {
      appendFileSync(logFile, data);
    });

    proc.stderr.on('data', (data) => {
      appendFileSync(logFile, `[STDERR] ${data}`);
    });

    proc.on('close', (code) => {
      processes.delete(task.id);

      const taskState = state.tasks[task.id];
      taskState.finished_at = new Date().toISOString();

      if (code === 0) {
        taskState.status = 'done';
        appendFileSync(logFile, `\n✅ Completed successfully\n`);
      } else {
        taskState.status = 'failed';
        taskState.error = `Exit code ${code}`;
        appendFileSync(logFile, `\n❌ Failed with exit code ${code}\n`);
      }

      saveState(state);
      resolve({ taskId: task.id, code });
    });

    proc.on('error', (err) => {
      processes.delete(task.id);
      state.tasks[task.id].status = 'failed';
      state.tasks[task.id].error = err.message;
      state.tasks[task.id].finished_at = new Date().toISOString();
      saveState(state);
      appendFileSync(logFile, `\n❌ Process error: ${err.message}\n`);
      resolve({ taskId: task.id, code: 1, error: err });
    });
  });
}

/**
 * Handle retry logic with model upgrade
 */
function shouldRetry(task, state) {
  const taskState = state.tasks[task.id];
  if (!taskState || taskState.retries >= (DEFAULTS.max_retries)) return null;

  const currentModel = taskState.current_model || task.model;

  if (taskState.retries === 0) {
    // First retry: same model
    return { ...task, model: currentModel };
  } else {
    // Subsequent retries: upgrade model
    const upgradedModel = MODEL_UPGRADE_PATH[currentModel] || currentModel;
    return { ...task, model: upgradedModel };
  }
}

/**
 * Main run command
 */
export async function run(planFile, opts) {
  // Load plan
  if (!existsSync(planFile)) {
    console.error(chalk.red(`  Plan file not found: ${planFile}`));
    console.error(chalk.dim('  Run `conductor plan` first'));
    process.exit(1);
  }

  const plan = JSON.parse(readFileSync(planFile, 'utf-8'));

  // Validate
  const errors = validatePlan(plan);
  if (errors.length > 0) {
    console.error(chalk.red('  Plan validation failed:'));
    for (const err of errors) console.error(chalk.red(`    ✗ ${err}`));
    process.exit(1);
  }

  // Setup
  mkdirSync(LOGS_DIR, { recursive: true });
  const state = loadState();
  const maxParallel = parseInt(opts.maxParallel) || DEFAULTS.max_parallel;
  const useWorktrees = isGitRepo();
  const baseBranch = useWorktrees ? getCurrentBranch() : null;
  state.base_branch = baseBranch;

  if (!useWorktrees) {
    console.log(chalk.yellow('  ⚠ Not a git repo — worktree isolation disabled, running sequentially'));
  }

  console.log();
  console.log(chalk.bold.cyan('🎼 Conductor — Starting execution'));
  console.log(chalk.dim(`   ${plan.tasks.length} tasks, max ${maxParallel} parallel`));
  console.log();

  // Dry run mode
  if (opts.dryRun) {
    console.log(chalk.yellow('  DRY RUN — showing commands that would be executed:\n'));
    for (const task of plan.tasks) {
      const args = buildClaudeArgs(task);
      console.log(chalk.dim(`  [${task.id}]`) + ` claude ${args.join(' ')}\n`);
    }
    return;
  }

  // Compute execution waves
  const waves = computeParallelGroups(plan.tasks);
  const taskMap = new Map(plan.tasks.map(t => [t.id, t]));
  const mergeResults = [];

  // Execute wave by wave
  for (let i = 0; i < waves.length; i++) {
    const wave = waves[i];
    console.log(chalk.bold(`  Wave ${i + 1}/${waves.length}: ${wave.join(', ')}`));

    // Limit parallelism within wave
    const tasksInWave = wave.map(id => taskMap.get(id));
    const sequential = opts.sequential || !useWorktrees;

    if (sequential) {
      // Sequential execution
      for (const task of tasksInWave) {
        const spinner = ora({ text: `${task.id}: ${task.name}`, color: 'cyan' }).start();

        // Create worktree if applicable
        let cwd = process.cwd();
        if (useWorktrees && task.worktree) {
          const { worktreePath, branchName } = createWorktree(task.id);
          cwd = worktreePath;
          state.tasks[task.id] = { ...state.tasks[task.id], worktree_branch: branchName };
        }

        const result = await runTask(task, cwd, state);

        if (result.code === 0) {
          spinner.succeed(`${task.id}: ${task.name} ${chalk.green('✓')}`);

          // Merge worktree if applicable
          if (useWorktrees && task.worktree) {
            const mergeResult = mergeWorktree(task.id, baseBranch);
            mergeResults.push({ taskId: task.id, ...mergeResult });
          }
        } else {
          // Retry logic
          const retryTask = shouldRetry(task, state);
          if (retryTask) {
            state.tasks[task.id].retries++;
            state.tasks[task.id].current_model = retryTask.model;
            saveState(state);

            spinner.warn(`${task.id}: retrying with ${retryTask.model}...`);
            const retryResult = await runTask(retryTask, cwd, state);

            if (retryResult.code === 0) {
              spinner.succeed(`${task.id}: ${task.name} ${chalk.green('✓')} (retry)`);
              if (useWorktrees && task.worktree) {
                mergeResults.push({ taskId: task.id, ...mergeWorktree(task.id, baseBranch) });
              }
            } else {
              spinner.fail(`${task.id}: ${task.name} ${chalk.red('✗')}`);
              if (useWorktrees && task.worktree) removeWorktree(task.id);
            }
          } else {
            spinner.fail(`${task.id}: ${task.name} ${chalk.red('✗')}`);
            if (useWorktrees && task.worktree) removeWorktree(task.id);
          }
        }
      }
    } else {
      // Parallel execution with concurrency limit
      const chunks = [];
      for (let j = 0; j < tasksInWave.length; j += maxParallel) {
        chunks.push(tasksInWave.slice(j, j + maxParallel));
      }

      for (const chunk of chunks) {
        const promises = chunk.map(async (task) => {
          // Create worktree
          let cwd = process.cwd();
          if (task.worktree) {
            const { worktreePath, branchName } = createWorktree(task.id);
            cwd = worktreePath;
            state.tasks[task.id] = { ...state.tasks[task.id], worktree_branch: branchName };
          }

          console.log(chalk.cyan(`  ▸ ${task.id}: ${task.name} [${task.model}] started`));
          const result = await runTask(task, cwd, state);

          if (result.code === 0) {
            console.log(chalk.green(`  ✓ ${task.id}: ${task.name} done`));
          } else {
            // Retry
            const retryTask = shouldRetry(task, state);
            if (retryTask) {
              state.tasks[task.id].retries++;
              state.tasks[task.id].current_model = retryTask.model;
              saveState(state);
              console.log(chalk.yellow(`  ↻ ${task.id}: retrying with ${retryTask.model}...`));

              const retryResult = await runTask(retryTask, cwd, state);
              if (retryResult.code !== 0) {
                console.log(chalk.red(`  ✗ ${task.id}: ${task.name} failed after retry`));
              } else {
                console.log(chalk.green(`  ✓ ${task.id}: ${task.name} done (retry)`));
              }
            } else {
              console.log(chalk.red(`  ✗ ${task.id}: ${task.name} failed`));
            }
          }

          return { task, result };
        });

        await Promise.all(promises);

        // Merge all worktrees from this chunk
        for (const task of chunk) {
          if (task.worktree && state.tasks[task.id]?.status === 'done') {
            mergeResults.push({ taskId: task.id, ...mergeWorktree(task.id, baseBranch) });
          } else if (task.worktree) {
            removeWorktree(task.id);
          }
        }
      }
    }
  }

  // Final summary
  console.log();
  console.log(chalk.bold.cyan('  ─── Execution Summary ───'));

  const done = plan.tasks.filter(t => state.tasks[t.id]?.status === 'done').length;
  const failed = plan.tasks.filter(t => state.tasks[t.id]?.status === 'failed').length;

  console.log(`  ${chalk.green(`✓ ${done} completed`)}  ${chalk.red(`✗ ${failed} failed`)}  ${chalk.dim(`of ${plan.tasks.length} total`)}`);

  // Merge conflicts summary
  const conflicts = mergeResults.filter(r => r.conflicts);
  if (conflicts.length > 0) {
    console.log();
    console.log(chalk.yellow('  ⚠ Merge conflicts on these branches (resolve manually):'));
    for (const c of conflicts) {
      console.log(chalk.yellow(`    git merge ${c.branch}`));
    }
  }

  console.log();
  console.log(chalk.dim('  View logs: conductor logs <task-id>'));
  console.log(chalk.dim('  Full status: conductor status'));
  console.log();
}

/**
 * Stop a running task or all tasks
 */
export async function stop(taskId) {
  if (taskId) {
    const proc = processes.get(taskId);
    if (proc) {
      treeKill(proc.pid, 'SIGTERM');
      console.log(chalk.yellow(`  Stopped task ${taskId}`));
    } else {
      console.log(chalk.dim(`  Task ${taskId} is not running`));
    }
  } else {
    // Stop all
    for (const [id, proc] of processes) {
      treeKill(proc.pid, 'SIGTERM');
      console.log(chalk.yellow(`  Stopped task ${id}`));
    }
  }
}
