# 🎼 Claude Conductor

**Orchestrate multiple Claude Code instances from a single todo list.**

You describe what you want to build. Conductor decomposes your tasks, picks the optimal model/settings for each one, and spawns parallel Claude Code instances — all without leaving your terminal.

## The Problem

You open Claude Code, describe your todo list, and it gives you optimized prompts for each task. Then you manually open 4 terminals, copy-paste prompts, set models, and juggle everything yourself.

**Conductor automates the entire second half.**

## How It Works

```
You (in Claude Code)              Conductor CLI
━━━━━━━━━━━━━━━━━━━━              ━━━━━━━━━━━━━━
                                  
/orchestrate                      
"Build auth, CRUD,                
 tests, and CI"                   
       │                          
       ▼                          
Claude Code analyzes              
your project & generates   ───▶   .conductor/plan.json
an optimized plan                 
       │                          
       ▼                          
You review & validate      ───▶   conductor run
       │                          
       │                            ┌─ claude -p "auth..." --model sonnet
       │                            ├─ claude -p "crud..." --model sonnet
       │                            │  (parallel, each in git worktree)
       │                            └─ ...waits for deps...
       │                               └─ claude -p "tests..." --model sonnet
       ▼                          
conductor status                  
  ✅ task-1: Auth JWT             
  ✅ task-2: User CRUD            
  🔄 task-3: Tests [running]      
  ⏳ task-4: Docs [waiting]       
```

## Features

- **Zero friction input** — describe tasks in natural language
- **Smart decomposition** — picks model (haiku/sonnet/opus), turns, mode per task
- **Parallel execution** — independent tasks run simultaneously
- **Git worktree isolation** — each task gets its own branch, auto-merged on completion
- **Auto-retry with model upgrade** — failed task retries same model, then upgrades (haiku→sonnet→opus)
- **Uses your subscription** — runs `claude -p` so it uses your Pro/Max plan, no API key needed
- **Stay in Claude Code** — the `/orchestrate` skill means you never leave your session

## Installation

```bash
# Install the CLI globally
npm install -g claude-conductor

# Install the Claude Code skill (copy to your project or globally)
cp skill/orchestrate.md ~/.claude/commands/orchestrate.md    # global
# or
cp skill/orchestrate.md .claude/commands/orchestrate.md      # project-level
```

## Usage

### Option 1: From inside Claude Code (recommended)

```
> /orchestrate Implement JWT auth with refresh tokens, create user CRUD 
  with pagination, write integration tests, and set up GitHub Actions CI
```

Claude Code will analyze your project, generate the plan, show it to you, and execute on your approval.

### Option 2: From the CLI directly

```bash
# Generate a plan from a todo list
conductor plan "Implement auth, add CRUD, write tests"

# Or from a file
conductor plan tasks.md

# Review the generated plan
cat .conductor/plan.json

# Execute
conductor run

# Monitor
conductor status --watch

# View task logs
conductor logs task-1

# Stop everything
conductor stop
```

### Option 3: Provide your own plan

Create `.conductor/plan.json` manually (see `examples/plan-example.json`), then:

```bash
conductor run .conductor/plan.json
```

## Plan Format

Each task in `plan.json` has:

| Field | Description |
|-------|-------------|
| `id` | Unique identifier (e.g., "task-1") |
| `name` | Human-readable name |
| `prompt` | Complete, self-contained prompt for Claude Code |
| `model` | `haiku`, `sonnet`, or `opus` |
| `permission_mode` | `plan` (read-only) or `acceptEdits` (can modify files) |
| `max_turns` | Max conversation turns (5-30) |
| `max_budget_usd` | Cost limit per task |
| `dependencies` | Task IDs that must complete first |
| `worktree` | Use git worktree isolation |
| `system_prompt_append` | Extra context for the instance |
| `rationale` | Why these parameters were chosen |

## Architecture

```
conductor plan                 conductor run                   conductor status
     │                              │                               │
     ▼                              ▼                               ▼
 Calls claude -p              Reads plan.json                 Reads state.json
 with meta-prompt      ──▶    Creates worktrees        ──▶   Shows live status
 to decompose tasks           Spawns claude -p instances      of all tasks
     │                        Manages retries                      
     ▼                        Merges branches                      
 Writes plan.json             Writes state.json + logs             
```

## Git Worktree Isolation

When tasks run in parallel, each gets its own git worktree (isolated branch). This prevents file conflicts. After a task completes successfully, its branch is auto-merged back. If there's a merge conflict, the branch is preserved for manual resolution.

```
main ──────────────────────────────────────▶
  ├── conductor/task-1 (auth) ──── merge ──┤
  ├── conductor/task-2 (crud) ──── merge ──┤
  └── conductor/task-3 (tests) waits... ───┤
```

## Retry Strategy

If a task fails:
1. **First retry**: same model, same prompt
2. **Second retry**: upgraded model (haiku→sonnet, sonnet→opus)
3. **After max retries**: marked as failed, user notified

## Requirements

- Node.js ≥ 18
- Claude Code CLI installed (`npm install -g @anthropic-ai/claude-code`)
- Claude Pro, Max, or Teams subscription (for `claude -p`)
- Git (for worktree isolation)

## Configuration

Global defaults can be set in `.conductor/config.json`:

```json
{
  "max_parallel": 4,
  "default_model": "sonnet",
  "max_retries": 2,
  "default_budget_usd": 5.0
}
```

## Contributing

PRs welcome! Main areas to improve:
- Better TUI with `ink` for real-time monitoring
- Cost tracking per task
- Session resume (continue from failed task)
- Plan templates for common patterns

## License

MIT
# CLAUDUCTOR
