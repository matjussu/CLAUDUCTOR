import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { spawn } from 'child_process';
import chalk from 'chalk';
import ora from 'ora';
import { CONDUCTOR_DIR, PLAN_FILE, validatePlan, DEFAULTS } from './schema.js';

/**
 * The meta-prompt that instructs Claude Code to decompose a todo list.
 * This is the brain of the whole system.
 */
function buildMetaPrompt(todoText) {
  return `Tu es un expert en orchestration de tâches de développement avec Claude Code.

L'utilisateur te donne une todo list. Tu dois analyser le projet actuel et décomposer chaque tâche en une spécification d'exécution optimisée.

## Instructions

1. **Analyse le projet** : regarde la structure des fichiers, le CLAUDE.md, le package.json/requirements.txt, le stack technique.

2. **Pour chaque tâche**, génère un objet JSON avec :
   - \`id\` : identifiant unique (ex: "task-1", "task-2")
   - \`name\` : nom court de la tâche
   - \`prompt\` : le prompt OPTIMISÉ et CONTEXTUALISÉ pour une instance Claude Code headless. Ce prompt doit être autonome — l'instance qui le recevra n'aura PAS le contexte de cette conversation. Inclus :
     * Ce qu'il faut faire précisément
     * Les fichiers concernés
     * Les contraintes techniques (framework, conventions, patterns existants)
     * Les critères de succès
   - \`model\` : "haiku" (tâches simples, formatage, renommage), "sonnet" (dev standard, CRUD, tests), ou "opus" (architecture complexe, debug difficile, sécurité)
   - \`permission_mode\` : "plan" (lecture seule, review, analyse) ou "acceptEdits" (modification de fichiers, implémentation)
   - \`max_turns\` : estimation du nombre de tours nécessaires (5-30)
   - \`max_budget_usd\` : budget max raisonnable pour cette tâche
   - \`dependencies\` : liste des IDs des tâches qui doivent être terminées avant celle-ci ([] si aucune)
   - \`worktree\` : true si la tâche modifie des fichiers (pour isolation git worktree)
   - \`system_prompt_append\` : contexte supplémentaire à injecter (conventions, patterns à suivre)
   - \`rationale\` : explication courte de tes choix (modèle, turns, etc.)

3. **Optimise le parallélisme** : minimise les dépendances pour que le max de tâches puissent tourner en parallèle.

4. **Output** : Réponds UNIQUEMENT avec un bloc JSON valide, pas de texte avant ou après :

\`\`\`json
{
  "project": "<nom du projet>",
  "created_at": "<ISO timestamp>",
  "description": "<résumé de la todo list>",
  "tasks": [...]
}
\`\`\`

## Todo list de l'utilisateur :

${todoText}`;
}

/**
 * Generate plan by calling Claude Code in headless mode
 * Claude Code already has the project context (files, CLAUDE.md, etc.)
 */
async function generatePlanWithClaude(todoText) {
  const prompt = buildMetaPrompt(todoText);

  return new Promise((resolve, reject) => {
    const args = [
      '-p', prompt,
      '--model', 'sonnet',
      '--max-turns', '5',
      '--output-format', 'json',
    ];

    const proc = spawn('claude', args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude Code exited with code ${code}\n${stderr}`));
        return;
      }

      try {
        // Claude Code --output-format json wraps the response
        // We need to extract the plan JSON from the response
        const response = JSON.parse(stdout);
        
        // The actual content is in the result field
        let planText = '';
        if (response.result) {
          planText = response.result;
        } else if (typeof response === 'string') {
          planText = response;
        } else {
          planText = stdout;
        }

        // Extract JSON from possible markdown code blocks
        const jsonMatch = planText.match(/```json\s*([\s\S]*?)\s*```/) 
                       || planText.match(/(\{[\s\S]*\})/);
        
        if (!jsonMatch) {
          reject(new Error('Could not extract plan JSON from Claude response'));
          return;
        }

        const plan = JSON.parse(jsonMatch[1]);
        resolve(plan);
      } catch (e) {
        reject(new Error(`Failed to parse plan: ${e.message}\nRaw output: ${stdout.slice(0, 500)}`));
      }
    });
  });
}

/**
 * Apply defaults to tasks that are missing optional fields
 */
function applyDefaults(plan) {
  for (const task of plan.tasks) {
    task.max_turns = task.max_turns ?? DEFAULTS.max_turns;
    task.max_budget_usd = task.max_budget_usd ?? DEFAULTS.max_budget_usd;
    task.permission_mode = task.permission_mode ?? DEFAULTS.permission_mode;
    task.dependencies = task.dependencies ?? [];
    task.worktree = task.worktree ?? true;
    task.system_prompt_append = task.system_prompt_append ?? '';
  }
  return plan;
}

/**
 * Display plan summary to the user
 */
function displayPlan(plan) {
  console.log();
  console.log(chalk.bold.cyan(`🎼 Conductor Plan — ${plan.project || 'Project'}`));
  console.log(chalk.dim(`   ${plan.description || ''}`));
  console.log(chalk.dim(`   Generated: ${plan.created_at}`));
  console.log();

  // Build dependency graph visual
  const taskMap = new Map(plan.tasks.map(t => [t.id, t]));

  for (const task of plan.tasks) {
    const modelColor = {
      haiku: chalk.green,
      sonnet: chalk.yellow,
      opus: chalk.red,
    }[task.model] || chalk.white;

    const modeIcon = task.permission_mode === 'plan' ? '👁️ ' : '✏️ ';
    const deps = task.dependencies.length > 0 
      ? chalk.dim(` ← depends on: ${task.dependencies.join(', ')}`)
      : '';

    console.log(
      `  ${chalk.bold(task.id)} ${modeIcon}${chalk.white.bold(task.name)}` +
      `  ${modelColor(`[${task.model}]`)}` +
      `  ${chalk.dim(`${task.max_turns} turns, $${task.max_budget_usd}`)}` +
      `${deps}`
    );
    console.log(chalk.dim(`         ${task.rationale || ''}`));
    console.log();
  }

  // Summary
  const totalBudget = plan.tasks.reduce((sum, t) => sum + (t.max_budget_usd || 0), 0);
  const parallelGroups = computeParallelGroups(plan.tasks);

  console.log(chalk.dim('  ─────────────────────────────────────'));
  console.log(`  ${chalk.bold(plan.tasks.length)} tasks • ${chalk.bold(parallelGroups.length)} waves • max budget ${chalk.bold(`$${totalBudget.toFixed(2)}`)}`);
  console.log();
}

/**
 * Group tasks into parallel execution waves based on dependencies
 */
function computeParallelGroups(tasks) {
  const groups = [];
  const completed = new Set();
  const remaining = [...tasks];

  while (remaining.length > 0) {
    const wave = remaining.filter(t =>
      t.dependencies.every(dep => completed.has(dep))
    );

    if (wave.length === 0) {
      // Deadlock — shouldn't happen if validatePlan passed
      throw new Error('Dependency deadlock detected');
    }

    groups.push(wave.map(t => t.id));

    for (const t of wave) {
      completed.add(t.id);
      remaining.splice(remaining.indexOf(t), 1);
    }
  }

  return groups;
}

/**
 * Main plan command
 */
export async function plan(input, opts) {
  // Determine input: file, stdin, or inline
  let todoText;

  if (input && existsSync(input)) {
    todoText = readFileSync(input, 'utf-8');
    console.log(chalk.dim(`  Reading tasks from ${input}`));
  } else if (input) {
    todoText = input;
  } else {
    // Read from stdin if piped
    if (!process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      todoText = Buffer.concat(chunks).toString('utf-8');
    } else {
      console.error(chalk.red('Error: Provide a tasks file, inline text, or pipe from stdin'));
      console.error(chalk.dim('  conductor plan "Implement auth, add tests, setup CI"'));
      console.error(chalk.dim('  conductor plan tasks.md'));
      console.error(chalk.dim('  echo "my tasks" | conductor plan'));
      process.exit(1);
    }
  }

  // Generate plan via Claude Code
  const spinner = ora({
    text: 'Analyzing project and decomposing tasks...',
    color: 'cyan',
  }).start();

  try {
    let generatedPlan = await generatePlanWithClaude(todoText);
    generatedPlan = applyDefaults(generatedPlan);

    // Validate
    const errors = validatePlan(generatedPlan);
    if (errors.length > 0) {
      spinner.fail('Plan validation failed');
      for (const err of errors) {
        console.error(chalk.red(`  ✗ ${err}`));
      }
      process.exit(1);
    }

    spinner.succeed('Plan generated');

    // Save plan
    mkdirSync(CONDUCTOR_DIR, { recursive: true });
    const outputPath = opts.output || PLAN_FILE;
    writeFileSync(outputPath, JSON.stringify(generatedPlan, null, 2));

    // Display
    displayPlan(generatedPlan);

    console.log(chalk.dim(`  Plan saved to ${outputPath}`));
    console.log();
    console.log(chalk.cyan('  Next steps:'));
    console.log(chalk.white('    1. Review the plan:  ') + chalk.dim(`cat ${outputPath}`));
    console.log(chalk.white('    2. Edit if needed:   ') + chalk.dim(`$EDITOR ${outputPath}`));
    console.log(chalk.white('    3. Execute:          ') + chalk.bold('conductor run'));
    console.log();

    if (opts.auto) {
      console.log(chalk.yellow('  --auto flag detected, launching execution...'));
      const { run } = await import('./runner.js');
      await run(outputPath, {});
    }
  } catch (error) {
    spinner.fail('Plan generation failed');
    console.error(chalk.red(`  ${error.message}`));
    process.exit(1);
  }
}

export { computeParallelGroups };
