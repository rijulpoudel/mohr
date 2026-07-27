# Mohr — Master Plan

> Budgeting SaaS. Solo founder. Build fast, build right.

---

## 1. Software Development Lifecycle (SDLC)

### Workflow

```
Issue → Branch → Commits → PR → Merge (squash) → Close Issue
```

| Step | What You Do |
|------|-------------|
| **1. Create Issue** | On GitHub. Describe what needs to be built. Add to a Milestone. |
| **2. Create Branch** | `git checkout -b feat/<issue-num>-short-name` |
| **3. Write Code** | Small, logical commits. One concern per commit. |
| **4. Open PR** | PR title = issue title. Body = summary of changes. |
| **5. Self-Merge** | Squash commit to `main`. Delete the branch. |
| **6. Close Issue** | Done. Move to next. |

### Branch Naming

```
feat/<num>-<kebab-description>
fix/<num>-<kebab-description>
chore/<num>-<kebab-description>
docs/<num>-<kebab-description>
```

### Commit Message Format

```
<type>: <short description>

Examples:
feat: add Prisma schema with User, Budget, Category models
feat: implement JWT signup and login routes
fix: correct email validation in auth routes
chore: add .gitignore and install deps
docs: add README with setup instructions
```

### Code Quality (Solo, Keep It Simple)

| Practice | How |
|----------|-----|
| One file = one concern | Routes in routes/, middleware in middleware/ |
| Handle errors | Always wrap async routes in try/catch |
| Use meaningful names | `budgetName` not `bn` |
| Remove dead code | If it's commented out, delete it |
| Keep secrets out | `.env` in gitignore ✅ |

---

## 2. Milestones

### Milestone 1: Foundation  (1–2 days)
**Goal:** Working backend with database and auth

| # | Issue | Est. |
|---|-------|------|
| 1 | Set up Prisma schema with User, Budget, Category, Transaction models | 30m |
| 2 | Add JWT auth (signup + login + middleware) | 1h |
| 3 | Create server.js with Express app setup | 30m |

### Milestone 2: Core API  (2–3 days)
**Goal:** Full CRUD for budgets, categories, transactions

| # | Issue | Est. |
|---|-------|------|
| 4 | Build Budget CRUD routes (create, list, get, update, delete) | 1.5h |
| 5 | Build Category routes (create under budget, list) | 1h |
| 6 | Build Transaction routes (create under category, list, filter by date) | 1.5h |

### Milestone 3: Frontend MVP  (1 week)
**Goal:** A working web app users can interact with

| # | Issue | Est. |
|---|-------|------|
| 7 | Learn React basics needed for this app | 2d |
| 8 | Build login/signup pages | 1d |
| 9 | Build dashboard with budgets list | 1d |
| 10 | Build budget detail page with categories + transactions | 1d |

### Milestone 4: Ship It  (3–4 days)
**Goal:** Deployed and usable

| # | Issue | Est. |
|---|-------|------|
| 11 | Containerize with Docker | 1d |
| 12 | Deploy backend to AWS (ECS or Railway) | 1d |
| 13 | Add custom domain + HTTPS | 1d |
| 14 | Polish: Loading states, error UI, responsive | 1d |

### Milestone 5: Post-Launch (Ongoing)
**Goal:** Make it a real product

| # | Issue | Est. |
|---|-------|------|
| 15 | Add spending limits and alerts | — |
| 16 | Add CSV import/export | — |
| 17 | Add recurring transactions | — |
| 18 | Multi-currency support | — |
| 19 | Plaid API integration (bank sync) | — |

---

## 3. Folder & File Structure

```
mohr/
├── backend/
│   ├── prisma/
│   │   └── schema.prisma       ← Database models
│   ├── middleware/
│   │   └── jwtAuth.js          ← JWT verification
│   ├── routes/
│   │   ├── auth.js             ← /signup, /login
│   │   ├── budgets.js          ← /budgets CRUD
│   │   ├── categories.js       ← /categories CRUD
│   │   └── transactions.js     ← /transactions CRUD
│   ├── prisma.js               ← PrismaClient singleton
│   ├── server.js               ← Express app entry point
│   ├── .env                    ← Secrets (gitignored)
│   └── package.json
├── frontend/                   ← React app (later)
├── AGENTS.md                   ← AI instructions for future sessions
├── CLAUDE.md                   ← AI instructions for Claude
├── PLAN.md                     ← This file
├── README.md                   ← Project overview for visitors
├── .gitignore
└── LICENSE
```

---

## 4. Issue Template (Copy This)

```
## Description
[What needs to be built/fixed]

## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Technical Notes
[Any implementation details, gotchas, or references]
```

---

## 5. PR Template (Copy This)

```
## Summary
[What does this PR do?]

## Changes
- [Change 1]
- [Change 2]

## Testing
- [ ] Tested locally with curl
- [ ] Edge cases handled (empty, invalid, missing)

## Related Issue
Closes #N
```

---

## 6. What We've Set Up So Far

```
✅ GitHub repo: rijulpoudel/mohr
✅ MIT License
✅ .gitignore (node_modules, .env, .DS_Store)
✅ backend/package.json (npm init -y)
✅ backend/node_modules (express, bcrypt, jsonwebtoken installed)
✅ backend/prisma.js (PrismaClient singleton — not yet created)
✅ CLAUDE.md (AI instructions for this repo)
✅ PLAN.md (this file)
```

---

## 7. Environment & Tools

| Tool | How to Get It |
|------|---------------|
| PostgreSQL 16 | `brew services start postgresql@16` |
| Node.js v22 | `node --version` ✅ |
| npm | `npm --version` ✅ |
| Prisma CLI | `npx prisma` (installed per project) |

### Ports
- Backend: 3001
- React dev server: 5173 (later)

### .env Template
```
DATABASE_URL="postgresql://localhost:5432/mohr?schema=public"
JWT_SECRET="<generate-a-random-string>"
```

---

## 8. Key Reminders

| Rule | Why |
|------|-----|
| Never commit to `main` directly | Branch + PR every time |
| Commit after every meaningful step | Easy rollback, clean history |
| Always `await` Prisma calls | Otherwise you get Promise objects, not data |
| `parseInt(id)` on route params | Prisma expects Int, not String |
| Start server on 3001 | Avoid port conflicts |
| One try/catch per handler | Don't crash the server |
