Overall Architecture

┌─────────────────────────────────────────────────────────┐
│                      SLACK                              │
│  ┌───────────┐  ┌──────────┐  ┌──────────┐              │
│  │ @mention  │  │   DM     │  │ /orbit   │              │
│  │ in channel│  │ message  │  │ commands │              │
│  └─────┬─────┘  └─────┬────┘  └─────┬────┘              │
└────────┼──────────────┼─────────────┼───────────────────┘
         │              │             │
         ▼              ▼             ▼
┌─────────────────────────────────────────────────────────┐
│                    ORBIT BOT                            │
│                   (Node.js)                             │
│                                                         │
│  ┌──────────────────────────────────┐                   │
│  │         MESSAGE ROUTER           │                   │
│  │  • Detects @Shehzad mentions     │                   │
│  │  • Receives DMs                  │                   │
│  │  • Handles /orbit commands       │                   │
│  └──────────────┬───────────────────┘                   │
│                 │                                       │
│                 ▼                                       │
│  ┌──────────────────────────────────┐                   │
│  │         CLASSIFIER               │                   │
│  │  Claude decides message type:    │                   │
│  │  • query                         │                   │
│  │  • code_query                    │                   │
│  │  • task                          │                   │
│  │  • pr_review                     │                   │
│  │  • schedule                      │                   │
│  │  • meeting_prep                  │                   │
│  └──────────┬───────────────────────┘                   │
│             │                                           │
│    ┌────────┼────────┬──────────┬──────────┐            │
│    ▼        ▼        ▼          ▼          ▼            │
│ ┌──────┐┌──────┐┌────────┐┌────────┐┌──────────┐        │
│ │Query ││Code  ││Task    ││PR      ││Schedule  │        │
│ │Reply ││Q&A   ││Runner  ││Review  ││Manager   │        │
│ └──────┘└──────┘└────────┘└────────┘└──────────┘        │
│                                                         │
│  ┌────────────────────────────────────────────┐         │
│  │          BACKGROUND SERVICES               │         │
│  │  • Activity Monitor (every 5m)             │         │
│  │  • Auto Standup (daily at 09:00)           │         │
│  │  • Deploy Watcher (after PR merge)         │         │
│  │  • Context Updater (after each task)       │         │
│  └────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────┘
         │              │              │
         ▼              ▼              ▼
   ┌──────────┐    ┌──────────┐    ┌──────────┐
   │ Claude   │    │  Linear  │    │  GitHub  │
   │ Code CLI │    │  API     │    │  (gh CLI)│
   │          │    │          │    │          │
   │ Analyzes │    │ Creates  │    │ Creates  │
   │ Codes    │    │ tickets  │    │ PRs      │
   │ Reviews  │    │ Updates  │    │ Reviews  │
   └──────────┘    └──────────┘    └──────────┘
















































Flow 1: Query Response

Someone: "@Shehzad what's the status of auth migration?"
                    │
                    ▼
        ┌───────────────────┐
        │  Detect @mention  │
        │  of OWNER_USER_ID │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  CLASSIFIER       │
        │  Claude reads msg │
        │  → type: "query"  │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Load Context     │
        │  ~/.orbit-context │
        │  ├── role.md      │
        │  ├── daily.md     │
        │  ├── platform.md  │
        │  ├── recent.md    │
        │  └── standup.md   │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Claude generates │
        │  response using   │
        │  your context     │
        │  + your tone      │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Post reply       │
        │  using USER TOKEN │
        │  (appears as YOU) │
        └───────────────────┘
                 │
                 ▼
Shehzad: "We finished token refresh last week,
        SSO integration is in progress —
        should be done by Thursday."











Flow 2: Codebase Q&A

Someone: "@Shehzad how does the pipeline work in orbit?"
                    │
                    ▼
        ┌───────────────────┐
        │  CLASSIFIER       │
        │  → type:          │
        │    "code_query"   │
        │  (mentions code,  │
        │   files, "how     │
        │   does X work")   │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Load context     │
        │  files (same as   │
        │  query)           │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────────────────────┐
        │  Run Claude CLI in WORKSPACE_ROOT │
        │  /Users/Shehzad/work/               │
        │                                   │
        │  Claude autonomously:             │
        │  • grep for relevant code         │
        │  • reads files                    │
        │  • traces function calls          │
        │  • understands the full flow      │
        └────────────┬──────────────────────┘
                     │
                     ▼
        ┌───────────────────┐
        │  Post reply       │
        │  with code refs   │
        │  (as YOU)         │
        └───────────────────┘
                 │
                 ▼
Shehzad: "Pipeline starts in core/src/pipeline.ts —
        processSingleTicket() does: pull → branch →
        Claude implements → QA (build/test/lint) →
        create PR. Events stream via EventEmitter
        so the bot picks them up in runner.ts."







Flow 3: Task Execution (Main Flow)

Someone: "@Shehzad can you fix the SSO logout bug?"
                    │
                    ▼
        ┌───────────────────┐
        │  CLASSIFIER       │
        │  → type: "task"   │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  IMMEDIATE REPLY  │
        │  (as YOU)         │
        │  "On it, I'll     │
        │   look into the   │
        │   SSO logout."    │
        └────────┬──────────┘
                 │
                 ▼
    ════════════════════════════
    ║  SILENT EXECUTION         ║
    ║  (no Slack messages       ║
    ║   until done)             ║
    ════════════════════════════
                 │
                 ▼
        ┌───────────────────┐
        │  1. ANALYZE       │
        │  Pull latest from │
        │  staging branch   │
        │  Scan codebase    │
        │  Prepare spec     │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  2. LINEAR TICKET │
        │  Create ticket    │
        │  with spec, files │
        │  acceptance       │
        │  criteria         │
        │  Move → In Prog.  │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  3. CODE          │
        │  Create feature   │
        │  branch           │
        │  Claude implements│
        │  changes          │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  4. QA            │
        │  ├── npm build    │──── ❌ Fail ──┐
        │  ├── npm test     │               │
        │  └── npm lint     │               ▼
        │                   │     ┌──────────────────┐
        │  All pass? ✅     │     │  Claude auto-fix  │
        └────────┬──────────┘     │  Retry (max 3x)  │
                 │                └────────┬─────────┘
                 │                         │
                 │◄────────────────────────┘
                 ▼
        ┌───────────────────┐
        │  5. CREATE PR     │
        │  gh pr create     │
        │  Description with │
        │  ticket link, QA  │
        │  results, spec    │
        │  (NO auto-merge)  │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  6. UPDATE LINEAR │
        │  Add PR comment   │
        │  Move → In Review │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  7. UPDATE        │
        │  CONTEXT FILES    │
        │  daily.md ←       │
        │  recent.md ←      │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  DONE REPLY       │
        │  (as YOU)         │
        │  "Fixed — PR #42  │
        │   fixes the SSO   │
        │   logout. SCL-55  │
        │   in review."     │
        └───────────────────┘








Flow 4: PR Review

Someone: "@Shehzad review PR #5"
                    │
                    ▼
        ┌───────────────────┐
        │  CLASSIFIER       │
        │  → type:          │
        │    "pr_review"    │
        │  Extracts: repo,  │
        │  PR number        │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  IMMEDIATE REPLY  │
        │  "Sure, I'll take │
        │   a look."        │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  gh pr diff 5     │
        │  Read the full    │
        │  diff             │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Claude analyzes  │
        │  the diff:        │
        │  • Logic errors?  │
        │  • Security?      │
        │  • Style?         │
        │  • Missing tests? │
        │  • Performance?   │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  gh pr review 5   │
        │  --approve /      │
        │  --comment /      │
        │  --request-changes│
        │                   │
        │  Posts inline      │
        │  comments on       │
        │  specific lines    │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  SLACK REPLY      │
        │  "Reviewed #5 —   │
        │   approved.       │
        │   Clean code,     │
        │   just one minor  │
        │   suggestion on   │
        │   error handling."│
        └───────────────────┘



Flow 5: Auto Standup

        ┌───────────────────┐
        │  CRON: 09:00 AM   │
        │  (daily)          │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Gather data:     │
        │                   │
        │  YESTERDAY:       │
        │  • git log --since│
        │    "24 hours ago" │
        │    across all     │
        │    repos          │
        │  • Linear tickets │
        │    completed      │
        │    yesterday      │
        │                   │
        │  TODAY:           │
        │  • Linear tickets │
        │    in progress /  │
        │    unstarted      │
        │  • Read daily.md  │
        │                   │
        │  BLOCKERS:        │
        │  • Read           │
        │    blockers.md    │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Post to          │
        │  STANDUP_CHANNEL   │
        │  (as YOU)         │
        └───────────────────┘
                 │
                 ▼
Shehzad: "Standup — Friday, Mar 20

        Yesterday:
        • Merged PR #42 — fix SSO logout
        • SCL-55 moved to review

        Today:
        • SCL-58 rate limiting
        • SCL-60 dark mode

        Blockers: None"
Flow 6: Scheduled Tasks

Someone: "@Shehzad fix the footer alignment tomorrow morning"
                    │
                    ▼
        ┌───────────────────┐
        │  CLASSIFIER       │
        │  → type:          │
        │    "schedule"     │
        │  Extracts:        │
        │  • task: "fix the │
        │    footer align." │
        │  • when: tomorrow │
        │    9:00 AM        │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────────┐
        │  IMMEDIATE REPLY      │
        │  "Got it, I'll start  │
        │   on this Sat, Mar 21 │
        │   09:00 AM."          │
        └────────┬──────────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Save to          │
        │  scheduled-       │
        │  tasks.json       │
        │  Start timer      │
        └────────┬──────────┘
                 │
                 │  (waits until scheduled time)
                 │
                 ▼
        ┌───────────────────┐
        │  Timer fires      │
        │  → Execute as     │
        │    normal TASK    │
        │    (Flow 3)       │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  "Fixed the       │
        │   footer — PR #48 │
        │   SCL-63 in       │
        │   review."        │
        └───────────────────┘
Flow 7: Catch-Up Summary

You: "/orbit catchup"
                    │
                    ▼
        ┌───────────────────┐
        │  Read interaction │
        │  log from disk    │
        │  .orbit-data/     │
        │  interactions-    │
        │  YYYY-MM-DD.json  │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Filter: last 4h  │
        │  (or custom       │
        │   /orbit catchup  │
        │   24h)            │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Format summary   │
        │  Group by type:   │
        │  • Queries        │
        │    answered       │
        │  • Tasks started/ │
        │    completed      │
        │  • PRs reviewed   │
        └────────┬──────────┘
                 │
                 ▼
You see: "While you were away:
         • Sara asked about API rate
           limits (explained our setup)
         • Ali reported login redirect
           bug (created SCL-62, PR #45)
         • PM asked sprint progress
           (shared ticket status)"
Flow 8: Deploy Monitoring

        ┌───────────────────┐
        │  PR #42 created   │
        │  (from Flow 3)    │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Start watching   │
        │  Poll every 2 min │
        │  for 30 minutes   │
        │                   │
        │  gh pr view 42    │
        │  --json statusC.. │
        └────────┬──────────┘
                 │
        ┌────────┼────────┐
        │        │        │
        ▼        ▼        ▼
    ┌───────┐┌───────┐┌───────┐
    │Deploy ││Deploy ││ 30min │
    │  ✅   ││  ❌   ││timeout│
    │Success││Failed ││       │
    └───┬───┘└───┬───┘└───┬───┘
        │        │        │
        ▼        ▼        ▼
    ┌───────┐┌───────┐┌───────┐
    │"Live  ││"Heads ││ Stop  │
    │on     ││up —   ││watching│
    │staging││deploy ││silently│
    │URL:.."││failed"││       │
    └───────┘└───────┘└───────┘
Flow 9: Feedback / Fix

Shehzad: "Fixed — PR #42. SCL-55 in review."
                    │
                    │  (thread is in "completed" state)
                    │
Someone replies in same thread:
"The badge should be centered, not left-aligned"
                    │
                    ▼
        ┌───────────────────┐
        │  Detect: reply in │
        │  completed thread │
        │  → FEEDBACK       │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  REPLY            │
        │  "Got it, I'll    │
        │   fix that."      │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Create fix ticket│
        │  in Linear with   │
        │  context from     │
        │  original session │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  Run Flow 3       │
        │  (Task Execution) │
        │  on the fix ticket│
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  "Fixed — PR #43  │
        │   centers the     │
        │   badge. SCL-56   │
        │   in review."     │
        └───────────────────┘
Flow 10: Activity Monitor (Background)

        ┌───────────────────┐
        │  EVERY 5 MINUTES  │
        │  (background)     │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────────────────────┐
        │  Scan WORKSPACE_ROOTS             │
        │  /Users/Shehzad/work/               │
        │  ├── scale-crx/                   │
        │  ├── orbit/                       │
        │  ├── platform-web/                │
        │  └── ...                          │
        │                                   │
        │  For each repo:                   │
        │  • git log --since="5 min ago"    │
        │  • git status (uncommitted)       │
        │  • git branch (current branch)    │
        └────────────┬──────────────────────┘
                     │
                     ▼
        ┌───────────────────┐
        │  Write to         │
        │  ~/.orbit-context │
        │  /activity.md     │
        │                   │
        │  "## 2026-03-20   │
        │   10:45 orbit:    │
        │   main — 2 new    │
        │   commits         │
        │   10:40 scale-crx:│
        │   feat/sso —      │
        │   3 uncommitted"  │
        └───────────────────┘
                 │
                 ▼
        ┌───────────────────┐
        │  This data feeds  │
        │  into:            │
        │  • Query answers  │
        │  • Standup        │
        │  • Catch-up       │
        └───────────────────┘
Flow 11: Code Style Learning

You: "/orbit learn-style"
                    │
                    ▼
        ┌───────────────────────────────────┐
        │  Scan all repos in WORKSPACE_ROOTS│
        │                                   │
        │  For each repo:                   │
        │  • git log --author="Shehzad"       │
        │    --since="30 days" -20          │
        │  • Read recent files you changed  │
        └────────────┬──────────────────────┘
                     │
                     ▼
        ┌───────────────────────────────────┐
        │  Claude analyzes YOUR code:       │
        │  • Naming: camelCase vs snake     │
        │  • Components: functional vs class│
        │  • Error handling patterns        │
        │  • Import ordering               │
        │  • Commit message format          │
        │  • Comment style                 │
        │  • Test patterns                 │
        └────────────┬──────────────────────┘
                     │
                     ▼
        ┌───────────────────┐
        │  Write to         │
        │  ~/.orbit-context │
        │  /style-guide.md  │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────────────────┐
        │  Future tasks include this    │
        │  style guide in Claude's      │
        │  prompt → code looks like     │
        │  YOU wrote it                 │
        └──────────────────────────────┘
Flow 12: Meeting Prep

Someone: "@Shehzad what should I know before sprint review?"
                    │
                    ▼
        ┌───────────────────┐
        │  CLASSIFIER       │
        │  → type:          │
        │    "meeting_prep" │
        └────────┬──────────┘
                 │
                 ▼
        ┌───────────────────────────────────┐
        │  Gather sprint data:              │
        │                                   │
        │  LINEAR:                          │
        │  • Completed tickets this sprint  │
        │  • In-progress tickets            │
        │  • Backlog / unstarted            │
        │                                   │
        │  GIT:                             │
        │  • PRs merged this sprint         │
        │  • Open PRs                       │
        │                                   │
        │  CONTEXT:                         │
        │  • recent.md                      │
        │  • blockers.md                    │
        └────────────┬──────────────────────┘
                     │
                     ▼
        ┌───────────────────┐
        │  Claude generates │
        │  sprint summary   │
        └────────┬──────────┘
                 │
                 ▼
Shehzad: "This sprint: 8/10 tickets done.
        Two still in review (SCL-55, 58).
        Auth migration 85% complete.
        Risk: SSO not tested with LDAP yet.
        3 PRs merged, 1 open."
Data Flow — What Feeds What

┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│  Git Repos  │     │   Linear    │     │   Slack     │
│  (local)    │     │   (API)     │     │ (messages)  │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       ▼                   ▼                   ▼
┌─────────────────────────────────────────────────────┐
│              ~/.orbit-context/                       │
│                                                      │
│  role.md ─────────── YOU write (one-time)            │
│  platform.md ──────── YOU write (one-time)           │
│  conventions.md ───── YOU write (one-time)           │
│  daily.md ─────────── AUTO-UPDATED after each task   │
│  recent.md ────────── AUTO-UPDATED after each task   │
│  activity.md ──────── AUTO-UPDATED every 5 min       │
│  style-guide.md ───── AUTO-UPDATED via /learn-style  │
│  blockers.md ──────── YOU write (as needed)           │
│  standup.md ───────── YOU write (as needed)           │
└──────────────────────────┬──────────────────────────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
        ┌──────────┐ ┌──────────┐ ┌──────────┐
        │  Query   │ │ Standup  │ │ Meeting  │
        │ Response │ │ Generator│ │  Prep    │
        └──────────┘ └──────────┘ └──────────┘
Response Identity

WITHOUT user token:                WITH user token:
┌────────────────────┐            ┌────────────────────┐
│ ┌──┐ Orbit    9:46 │            │ ┌──┐ Shehzad    9:46 │
│ │🤖│ On it, I'll   │            │ │👤│ On it, I'll   │
│ └──┘ fix the SSO   │            │ └──┘ fix the SSO   │
│      logout.       │            │      logout.       │
└────────────────────┘            └────────────────────┘
    ❌ Everyone knows              ✅ Looks like you
       it's a bot                     replied yourself