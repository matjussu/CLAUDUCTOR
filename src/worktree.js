import { execSync, exec } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import chalk from 'chalk';

const WORKTREE_PREFIX = 'conductor';

/**
 * Check if we're in a git repository
 */
export function isGitRepo() {
  try {
    execSync('git rev-parse --is-inside-work-tree', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current branch name
 */
export function getCurrentBranch() {
  return execSync('git branch --show-current', { stdio: 'pipe' }).toString().trim();
}

/**
 * Create an isolated git worktree for a task
 * Returns the worktree path and branch name
 */
export function createWorktree(taskId) {
  const branchName = `${WORKTREE_PREFIX}/${taskId}`;
  const worktreePath = join('.conductor', 'worktrees', taskId);

  // Clean up if exists from a previous run
  if (existsSync(worktreePath)) {
    try {
      execSync(`git worktree remove "${worktreePath}" --force`, { stdio: 'pipe' });
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
    }
  }

  // Delete branch if it exists from a previous run
  try {
    execSync(`git branch -D "${branchName}"`, { stdio: 'pipe' });
  } catch {
    // Branch doesn't exist, that's fine
  }

  // Create worktree with new branch from current HEAD
  const baseBranch = getCurrentBranch() || 'HEAD';
  execSync(
    `git worktree add -b "${branchName}" "${worktreePath}" ${baseBranch}`,
    { stdio: 'pipe' }
  );

  return { worktreePath, branchName };
}

/**
 * Remove a worktree after task completion
 */
export function removeWorktree(taskId) {
  const worktreePath = join('.conductor', 'worktrees', taskId);
  try {
    execSync(`git worktree remove "${worktreePath}" --force`, { stdio: 'pipe' });
  } catch {
    // Best effort cleanup
  }
}

/**
 * Merge a task's worktree branch back into the base branch
 */
export function mergeWorktree(taskId, baseBranch) {
  const branchName = `${WORKTREE_PREFIX}/${taskId}`;

  try {
    // First, remove the worktree (we need to be on the base branch to merge)
    removeWorktree(taskId);

    // Check if the branch has any changes
    const diffOutput = execSync(
      `git diff ${baseBranch}...${branchName} --stat`,
      { stdio: 'pipe' }
    ).toString().trim();

    if (!diffOutput) {
      console.log(chalk.dim(`  Task ${taskId}: no changes to merge`));
      return { merged: false, conflicts: false };
    }

    // Try to merge
    try {
      execSync(`git merge "${branchName}" --no-edit`, { stdio: 'pipe' });
      console.log(chalk.green(`  ✓ Task ${taskId}: merged successfully`));

      // Clean up branch
      execSync(`git branch -d "${branchName}"`, { stdio: 'pipe' });

      return { merged: true, conflicts: false };
    } catch (mergeError) {
      // Merge conflict
      execSync('git merge --abort', { stdio: 'pipe' });
      console.log(chalk.yellow(`  ⚠ Task ${taskId}: merge conflict, branch kept as ${branchName}`));
      return { merged: false, conflicts: true, branch: branchName };
    }
  } catch (error) {
    console.error(chalk.red(`  ✗ Task ${taskId}: merge error — ${error.message}`));
    return { merged: false, conflicts: false, error: error.message };
  }
}

/**
 * Clean up all conductor worktrees
 */
export function cleanupAllWorktrees() {
  try {
    const output = execSync('git worktree list --porcelain', { stdio: 'pipe' }).toString();
    const worktrees = output.split('\n\n').filter(w => w.includes(WORKTREE_PREFIX));

    for (const wt of worktrees) {
      const pathMatch = wt.match(/worktree (.+)/);
      if (pathMatch) {
        try {
          execSync(`git worktree remove "${pathMatch[1]}" --force`, { stdio: 'pipe' });
        } catch {
          // Best effort
        }
      }
    }
  } catch {
    // Not a git repo or no worktrees
  }
}
