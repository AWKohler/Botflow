import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import unzipper from "unzipper";
import { spawn } from "child_process";

const port = process.env.PORT || 8080;

const AUTH_HEADER = "authorization";
const EXPECTED_TOKEN = process.env.WORKER_AUTH_TOKEN;

if (!EXPECTED_TOKEN) {
  throw new Error("WORKER_AUTH_TOKEN is not set");
}

function run(cmd, args, { cwd, env, logBuffer }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env });

    child.stdout.on("data", (d) => {
      const text = d.toString();
      logBuffer.push(text);
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      logBuffer.push(text);
    });

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// Like run(), but captures stdout separately (for commands whose stdout IS the
// result, e.g. `convex function-spec`). stderr still goes to the log buffer.
function runCapture(cmd, args, { cwd, env, logBuffer }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env });
    const out = [];

    child.stdout.on("data", (d) => out.push(d.toString()));
    child.stderr.on("data", (d) => logBuffer.push(d.toString()));

    child.on("close", (code) => {
      if (code === 0) resolve(out.join(""));
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

// Recursively read all files in a directory
function readDirRecursive(dir, baseDir = dir) {
  const files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...readDirRecursive(fullPath, baseDir));
    } else {
      const relativePath = path.relative(baseDir, fullPath);
      const content = fs.readFileSync(fullPath, "utf8");
      files.push({ path: relativePath, content });
    }
  }

  return files;
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end();
  }

  const auth = req.headers[AUTH_HEADER];
  if (auth !== `Bearer ${EXPECTED_TOKEN}`) {
    res.writeHead(401);
    return res.end("unauthorized");
  }

  const deployKey = (req.headers["x-convex-deploy-key"] || "").trim();
  if (!deployKey) {
    res.writeHead(400);
    return res.end("Missing or empty X-Convex-Deploy-Key");
  }

  const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), "convex-job-"));
  const logBuffer = [];

  try {
    // Save ZIP
    const zipPath = path.join(jobDir, "snapshot.zip");
    const writeStream = fs.createWriteStream(zipPath);
    req.pipe(writeStream);

    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    // Extract ZIP
    await fs
      .createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: jobDir }))
      .promise();

    logBuffer.push("Installing dependencies...\n");

    // Detect package manager from lock file
    const hasPnpmLock = fs.existsSync(path.join(jobDir, "pnpm-lock.yaml"));
    if (hasPnpmLock) {
      await run("pnpm", ["install", "--no-frozen-lockfile", "--prod"], {
        cwd: jobDir,
        env: process.env,
        logBuffer,
      });
    } else {
      await run("npm", ["install", "--omit=dev"], {
        cwd: jobDir,
        env: process.env,
        logBuffer,
      });
    }

    logBuffer.push("\nRunning convex deploy...\n");

    await run("convex", ["deploy"], {
      cwd: jobDir,
      env: {
        ...process.env,
        CONVEX_DEPLOY_KEY: deployKey,
      },
      logBuffer,
    });

    logBuffer.push("\n✅ Convex deploy completed successfully\n");

    // Read generated files from convex/_generated/
    let generatedFiles = [];
    const generatedDir = path.join(jobDir, "convex", "_generated");
    if (fs.existsSync(generatedDir)) {
      logBuffer.push("\nCollecting generated types...\n");
      generatedFiles = readDirRecursive(generatedDir, generatedDir);
      logBuffer.push(`Collected ${generatedFiles.length} generated file(s)\n`);
    }

    // Capture the deployed function manifest (names, types, visibility).
    // The platform uses it for client codegen (e.g. Swift function-name
    // constants). Non-fatal: a spec failure must never fail the deploy.
    let functionSpec = null;
    try {
      const specJson = await runCapture("convex", ["function-spec"], {
        cwd: jobDir,
        env: { ...process.env, CONVEX_DEPLOY_KEY: deployKey },
        logBuffer,
      });
      functionSpec = JSON.parse(specJson);
      const count = Array.isArray(functionSpec?.functions)
        ? functionSpec.functions.length
        : 0;
      logBuffer.push(`Collected function spec (${count} function(s))\n`);
    } catch (specErr) {
      logBuffer.push(
        `⚠️ function-spec failed (non-fatal): ${specErr.message || specErr}\n`
      );
    }

    // Return JSON response with logs and generated files
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        success: true,
        logs: logBuffer.join(""),
        generatedFiles: generatedFiles.map((f) => ({
          path: f.path,
          content: f.content,
        })),
        ...(functionSpec ? { functionSpec } : {}),
      })
    );
  } catch (err) {
    const errMsg = err.message || String(err);
    // Include the full log buffer in the error so the caller sees npm/convex CLI output
    const fullLogs = logBuffer.join("");
    console.error("Deploy failed:", errMsg, "\nLogs:", fullLogs);
    logBuffer.push(`\n❌ Error: ${errMsg}\n`);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(
      JSON.stringify({
        success: false,
        logs: logBuffer.join(""),
        error: errMsg,
        generatedFiles: [],
      })
    );
  }
});

server.listen(port, () => {
  console.log(`Worker listening on ${port}`);
});
