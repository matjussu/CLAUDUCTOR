// ─── Constants & Configuration ──────────────────────────────────
// These define the contract between the skill (brain) and the CLI (executor)

export const CONDUCTOR_DIR = '.conductor';
export const PLAN_FILE = `${CONDUCTOR_DIR}/plan.json`;
export const STATE_FILE = `${CONDUCTOR_DIR}/state.json`;
export const LOGS_DIR = `${CONDUCTOR_DIR}/logs`;

// Valid values for plan fields
export const MODELS = ['haiku', 'sonnet', 'opus'];
export const PERMISSION_MODES = ['plan', 'execute', 'acceptEdits'];
export const TASK_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped'];

// Retry strategy: same model first, then upgrade
export const MODEL_UPGRADE_PATH = {
  haiku: 'sonnet',
  sonnet: 'opus',
  opus: 'opus', // opus retries as opus
};

// Default limits
export const DEFAULTS = {
  max_turns: 15,
  max_budget_usd: 5.0,
  max_retries: 2,
  max_parallel: 4,
  permission_mode: 'acceptEdits',
};

/**
 * Schema for a single task in plan.json
 * 
 * @typedef {Object} Task
 * @property {string} id             - Unique task identifier (e.g., "task-1")
 * @property {string} name           - Human-readable name
 * @property {string} prompt         - The optimized prompt for Claude Code
 * @property {string} model          - "haiku" | "sonnet" | "opus"
 * @property {string} permission_mode - "plan" | "execute" | "acceptEdits"
 * @property {number} max_turns      - Max conversation turns
 * @property {number} max_budget_usd - Max spend for this task
 * @property {string[]} dependencies - IDs of tasks that must complete first
 * @property {boolean} worktree      - Whether to use git worktree isolation
 * @property {string} [system_prompt_append] - Extra context to append
 * @property {string} rationale      - Why these params were chosen
 */

/**
 * Schema for plan.json
 * 
 * @typedef {Object} Plan
 * @property {string} project        - Project name (from CLAUDE.md or dir name)
 * @property {string} created_at     - ISO timestamp
 * @property {string} description    - What the todo list is about
 * @property {Task[]} tasks          - The task list
 */

/**
 * Schema for state.json (runtime tracking)
 * 
 * @typedef {Object} TaskState
 * @property {string} id
 * @property {string} status         - pending | running | done | failed | skipped
 * @property {number} pid            - Process ID of the claude instance
 * @property {string} started_at     - ISO timestamp
 * @property {string} [finished_at]
 * @property {number} retries        - Number of retries so far
 * @property {string} current_model  - Model currently being used (may differ after upgrade)
 * @property {string} worktree_branch - Branch name if using worktree
 * @property {string} [error]        - Error message if failed
 */

/**
 * Validate a plan object
 */
export function validatePlan(plan) {
  const errors = [];

  if (!plan.tasks || !Array.isArray(plan.tasks)) {
    errors.push('plan.tasks must be an array');
    return errors;
  }

  const taskIds = new Set(plan.tasks.map(t => t.id));

  for (const task of plan.tasks) {
    if (!task.id) errors.push(`Task missing id`);
    if (!task.prompt) errors.push(`Task ${task.id}: missing prompt`);
    if (task.model && !MODELS.includes(task.model)) {
      errors.push(`Task ${task.id}: invalid model "${task.model}"`);
    }
    if (task.permission_mode && !PERMISSION_MODES.includes(task.permission_mode)) {
      errors.push(`Task ${task.id}: invalid permission_mode "${task.permission_mode}"`);
    }
    if (task.dependencies) {
      for (const dep of task.dependencies) {
        if (!taskIds.has(dep)) {
          errors.push(`Task ${task.id}: dependency "${dep}" not found in plan`);
        }
      }
    }
  }

  // Check for circular dependencies
  const visited = new Set();
  const visiting = new Set();

  function hasCycle(taskId) {
    if (visiting.has(taskId)) return true;
    if (visited.has(taskId)) return false;
    visiting.add(taskId);
    const task = plan.tasks.find(t => t.id === taskId);
    if (task?.dependencies) {
      for (const dep of task.dependencies) {
        if (hasCycle(dep)) return true;
      }
    }
    visiting.delete(taskId);
    visited.add(taskId);
    return false;
  }

  for (const task of plan.tasks) {
    if (hasCycle(task.id)) {
      errors.push(`Circular dependency detected involving task "${task.id}"`);
      break;
    }
  }

  return errors;
}
