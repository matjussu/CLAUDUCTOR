#!/usr/bin/env node

import { Command } from 'commander';
import { plan } from '../src/planner.js';
import { run } from '../src/runner.js';
import { status } from '../src/monitor.js';
import { stop } from '../src/runner.js';
import { logs } from '../src/monitor.js';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));

const program = new Command();

program
  .name('conductor')
  .description('🎼 Orchestrate multiple Claude Code instances from a single todo list')
  .version(pkg.version);

// ─── conductor plan ────────────────────────────────────────────
program
  .command('plan')
  .description('Generate an execution plan from a todo list or plan.json')
  .argument('[input]', 'Path to a tasks file (.md, .txt, .json) or inline text')
  .option('-o, --output <path>', 'Output plan file', '.conductor/plan.json')
  .option('--auto', 'Skip the review step and go straight to run')
  .action(async (input, opts) => {
    await plan(input, opts);
  });

// ─── conductor run ─────────────────────────────────────────────
program
  .command('run')
  .description('Execute tasks from a plan.json')
  .argument('[planFile]', 'Path to plan file', '.conductor/plan.json')
  .option('--dry-run', 'Show what would be executed without running')
  .option('--sequential', 'Force sequential execution (no parallelism)')
  .option('--max-parallel <n>', 'Max parallel tasks', '4')
  .action(async (planFile, opts) => {
    await run(planFile, opts);
  });

// ─── conductor status ──────────────────────────────────────────
program
  .command('status')
  .description('Show the status of running/completed tasks')
  .option('--watch', 'Auto-refresh every 2 seconds')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    await status(opts);
  });

// ─── conductor logs ────────────────────────────────────────────
program
  .command('logs')
  .description('Show logs for a specific task')
  .argument('<taskId>', 'Task ID from the plan')
  .option('-f, --follow', 'Follow log output in real time')
  .action(async (taskId, opts) => {
    await logs(taskId, opts);
  });

// ─── conductor stop ────────────────────────────────────────────
program
  .command('stop')
  .description('Stop a running task or all tasks')
  .argument('[taskId]', 'Task ID to stop (omit to stop all)')
  .action(async (taskId) => {
    await stop(taskId);
  });

program.parse();
