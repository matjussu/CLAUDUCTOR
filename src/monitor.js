import { readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';
import { CONDUCTOR_DIR, STATE_FILE, LOGS_DIR, PLAN_FILE } from './schema.js';

/**
 * Format a duration in seconds to a human-readable string
 */
function formatDuration(startIso, endIso) {
  const start = new Date(startIso);
  const end = endIso ? new Date(endIso) : new Date();
  const seconds = Math.floor((end - start) / 1000);

  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Display the status of all tasks
 */
export async function status(opts) {
  if (!existsSync(STATE_FILE)) {
    console.error(chalk.dim('  No active run found. Run `conductor run` first.'));
    return;
  }

  const renderOnce = () => {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    let plan = null;
    if (existsSync(PLAN_FILE)) {
      plan = JSON.parse(readFileSync(PLAN_FILE, 'utf-8'));
    }

    if (opts.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }

    // Clear screen for watch mode
    if (opts.watch) {
      process.stdout.write('\x1B[2J\x1B[0f');
    }

    console.log();
    console.log(chalk.bold.cyan('🎼 Conductor Status'));
    console.log(chalk.dim(`   Started: ${state.started_at || 'unknown'}`));
    console.log();

    const statusIcons = {
      pending: '⏳',
      running: '🔄',
      done: '✅',
      failed: '❌',
      skipped: '⏭️ ',
    };

    const statusColors = {
      pending: chalk.dim,
      running: chalk.cyan,
      done: chalk.green,
      failed: chalk.red,
      skipped: chalk.dim,
    };

    // Merge plan info with state info
    const tasks = Object.values(state.tasks);

    for (const task of tasks) {
      const planTask = plan?.tasks?.find(t => t.id === task.id);
      const icon = statusIcons[task.status] || '❓';
      const color = statusColors[task.status] || chalk.white;
      const name = planTask?.name || task.id;
      const model = task.current_model || planTask?.model || '?';

      let duration = '';
      if (task.started_at) {
        duration = chalk.dim(` (${formatDuration(task.started_at, task.finished_at)})`);
      }

      let retryInfo = '';
      if (task.retries > 0) {
        retryInfo = chalk.yellow(` [retry ${task.retries}]`);
      }

      let errorInfo = '';
      if (task.error) {
        errorInfo = chalk.red(`\n         ${task.error}`);
      }

      console.log(
        `  ${icon} ${color(chalk.bold(task.id))} ${color(name)}` +
        `  ${chalk.dim(`[${model}]`)}` +
        `${duration}${retryInfo}${errorInfo}`
      );
    }

    // Summary line
    const counts = {
      done: tasks.filter(t => t.status === 'done').length,
      running: tasks.filter(t => t.status === 'running').length,
      failed: tasks.filter(t => t.status === 'failed').length,
      pending: tasks.filter(t => t.status === 'pending').length,
    };

    console.log();
    console.log(chalk.dim('  ─────────────────────────────────────'));
    console.log(
      `  ${chalk.green(`✓${counts.done}`)} ` +
      `${chalk.cyan(`⟳${counts.running}`)} ` +
      `${chalk.red(`✗${counts.failed}`)} ` +
      `${chalk.dim(`⏳${counts.pending}`)}`
    );
    console.log();
  };

  renderOnce();

  if (opts.watch) {
    setInterval(renderOnce, 2000);
  }
}

/**
 * Show logs for a specific task
 */
export async function logs(taskId, opts) {
  const logFile = join(LOGS_DIR, `${taskId}.log`);

  if (!existsSync(logFile)) {
    console.error(chalk.red(`  No logs found for task ${taskId}`));
    console.error(chalk.dim(`  Expected: ${logFile}`));
    return;
  }

  if (opts.follow) {
    // Tail -f behavior
    const { spawn } = await import('child_process');
    const tail = spawn('tail', ['-f', logFile], { stdio: 'inherit' });
    tail.on('close', () => process.exit(0));

    process.on('SIGINT', () => {
      tail.kill();
      process.exit(0);
    });
  } else {
    const content = readFileSync(logFile, 'utf-8');
    console.log(content);
  }
}
