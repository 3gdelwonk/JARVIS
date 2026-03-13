@echo off
REM ═══════════════════════════════════════════════════════════
REM  IGA Milk Manager — Project Bootstrap for Claude Code
REM  Run this ONCE from your project folder on Windows
REM ═══════════════════════════════════════════════════════════

echo.
echo  IGA Milk Manager — Setting up project...
echo  ==========================================
echo.

REM Check Node.js
node --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org
    echo  Download the LTS version, restart your terminal, then run this again.
    pause
    exit /b 1
)
echo  [OK] Node.js found

REM Check Git
git --version >nul 2>&1
if %ERRORLEVEL% neq 0 (
    echo  ERROR: Git not found. Install from https://git-scm.com
    pause
    exit /b 1
)
echo  [OK] Git found

REM Initialize project with Vite
echo.
echo  Creating React + TypeScript project with Vite...
npm create vite@latest . -- --template react-ts
if %ERRORLEVEL% neq 0 (
    echo  Vite init may have prompted — if folder not empty, choose to overwrite.
)

REM Install all dependencies
echo.
echo  Installing dependencies...
call npm install dexie dexie-react-hooks papaparse recharts lucide-react date-fns xlsx pdfjs-dist
call npm install -D @types/papaparse tailwindcss postcss autoprefixer vitest vite-plugin-pwa @vite-pwa/assets-generator

REM Initialize Tailwind
echo.
echo  Setting up Tailwind CSS...
npx tailwindcss init -p

REM Initialize Git
echo.
echo  Initializing Git repository...
git init
git add -A
git commit -m "Initial project scaffold"

echo.
echo  ==========================================
echo  Project setup complete!
echo.
echo  Next steps:
echo  1. Open this folder in VS Code: code .
echo  2. Open Claude Code (terminal) in VS Code
echo  3. Tell Claude: "Read CLAUDE.md, SPECS.md, and TASKS.md, then start Session 1"
echo.
echo  Key files:
echo    CLAUDE.md   — Master context (business rules, product data)
echo    SPECS.md    — Technical specs (DB schema, module design)
echo    TASKS.md    — Build plan (16 sessions, checkboxes)
echo    PITFALLS.md — Known gotchas and edge cases
echo    AUDIT.md    — Risk assessment and cost audit
echo  ==========================================
pause
