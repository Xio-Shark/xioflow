/**
 * Integration tests for task creation with tech stack detection,
 * stack gotchas/cookbooks, and 3-piece task artifacts (prd.md, todolist.md, verification.md).
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEMPLATE_SCRIPTS = path.resolve(
  __dirname,
  "../../src/templates/trellis/scripts",
);

const DEVELOPER = "tester";

function hasPython(): boolean {
  try {
    execFileSync("python3", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function setupRepo(tmp: string): void {
  fs.mkdirSync(tmp, { recursive: true });
  for (const wfDir of [".xioflow", ".trellis"]) {
    const scriptsDest = path.join(tmp, wfDir, "scripts");
    fs.mkdirSync(scriptsDest, { recursive: true });
    fs.cpSync(TEMPLATE_SCRIPTS, scriptsDest, { recursive: true });
  }

  const scriptPath = fs.existsSync(path.join(tmp, ".xioflow", "scripts", "init_developer.py"))
    ? ".xioflow/scripts/init_developer.py"
    : ".trellis/scripts/init_developer.py";

  const r = spawnSync(
    "python3",
    [scriptPath, DEVELOPER],
    { cwd: tmp, encoding: "utf-8" },
  );
  if (r.status !== 0) {
    throw new Error(`init_developer failed: ${r.stderr}`);
  }
}

function runTask(repo: string, ...args: string[]) {
  const scriptPath = fs.existsSync(path.join(repo, ".xioflow", "scripts", "task.py"))
    ? ".xioflow/scripts/task.py"
    : ".trellis/scripts/task.py";

  return spawnSync("python3", [scriptPath, ...args], {
    cwd: repo,
    encoding: "utf-8",
  });
}

function getTasksDir(repo: string): string {
  if (fs.existsSync(path.join(repo, ".xioflow", "tasks"))) {
    return path.join(repo, ".xioflow", "tasks");
  }
  return path.join(repo, ".trellis", "tasks");
}

const suite = hasPython() ? describe : describe.skip;

suite("task.py create with stack detection and 3-piece artifacts", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-stack-test-"));
    setupRepo(tmp);
  });

  afterEach(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it("auto-detects node/react stack and generates prd, todolist, and verification files", () => {
    // Write package.json with react dependency
    fs.writeFileSync(
      path.join(tmp, "package.json"),
      JSON.stringify({ dependencies: { react: "^18.0.0" } }),
      "utf-8",
    );

    const r = runTask(
      tmp,
      "create",
      "Build Login Flow",
      "--description",
      "Implement login with oauth",
      "--slug",
      "build-login",
      "--no-start",
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Target Tech Stack: react");
    expect(r.stderr).toContain("todolist.md");
    expect(r.stderr).toContain("verification.md");

    const tasksDir = getTasksDir(tmp);
    const dirs = fs.readdirSync(tasksDir).filter((d) => d.endsWith("-build-login"));
    expect(dirs.length).toBe(1);
    const taskDir = path.join(tasksDir, dirs[0]);

    // Check files created
    expect(fs.existsSync(path.join(taskDir, "task.json"))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, "prd.md"))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, "todolist.md"))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, "verification.md"))).toBe(true);

    // Verify task.json meta.stack
    const taskData = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"));
    expect(taskData.meta?.stack).toBe("react");

    // Verify prd.md content has glue coding research & stack gotchas
    const prdContent = fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8");
    expect(prdContent).toContain("`React`");
    expect(prdContent).toContain("Glue Coding Principle");
    expect(prdContent).toContain("Open-Source Investigation");
    expect(prdContent).toContain("Tech Stack Gotchas & Anti-Patterns (React)");
    expect(prdContent).toContain("Official Cookbooks & References");

    // Verify todolist.md content
    const todoContent = fs.readFileSync(path.join(taskDir, "todolist.md"), "utf-8");
    expect(todoContent).toContain("Todo List");
    expect(todoContent).toContain("Step 1: Planning & Research");
    expect(todoContent).toContain("Step 2: Core Implementation");
    expect(todoContent).toContain("Step 3: Verification & Evidence");

    // Verify verification.md content
    const verifyContent = fs.readFileSync(path.join(taskDir, "verification.md"), "utf-8");
    expect(verifyContent).toContain("Verification & Comparison");
    expect(verifyContent).toContain("Before / After Comparison");
    expect(verifyContent).toContain("Real Execution Evidence");
  });

  it("allows explicit --stack override and injects corresponding gotchas and cookbooks", () => {
    const r = runTask(
      tmp,
      "create",
      "FastAPI Async Pipeline",
      "--description",
      "Setup async worker endpoint",
      "--slug",
      "fastapi-pipe",
      "--stack",
      "fastapi",
      "--no-start",
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Target Tech Stack: fastapi");

    const tasksDir = getTasksDir(tmp);
    const dirs = fs.readdirSync(tasksDir).filter((d) => d.endsWith("-fastapi-pipe"));
    expect(dirs.length).toBe(1);
    const taskDir = path.join(tasksDir, dirs[0]);

    const taskData = JSON.parse(fs.readFileSync(path.join(taskDir, "task.json"), "utf-8"));
    expect(taskData.meta?.stack).toBe("fastapi");

    const prdContent = fs.readFileSync(path.join(taskDir, "prd.md"), "utf-8");
    expect(prdContent).toContain("Python (FastAPI / Async)");
    expect(prdContent).toContain("Event Loop Blocking");
    expect(prdContent).toContain("FastAPI Official Tutorial");
  });
});
