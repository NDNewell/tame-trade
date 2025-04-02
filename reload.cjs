#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { watch } = require('fs/promises');

// Track the application process
let appProcess = null;
let isRestarting = false;
let debounceTimer = null;
const DEBOUNCE_TIME = 1000; // 1 second debounce

// Parse command line arguments
const args = process.argv.slice(2);
const noPasswordAuth = args.includes('-np') || args.includes('-no_password');

// Directories to watch for changes
const watchDirs = [
  path.join(process.cwd(), 'src'),
  path.join(process.cwd(), 'plugins')
];

// File extensions to watch for changes
const watchExtensions = ['.ts', '.js', '.json'];

// Start the application
function startApp() {
  if (noPasswordAuth) {
    console.log('Starting application in development mode with password verification disabled.');
  } else {
    console.log('Starting application in development mode.');
  }

  // Set environment variables for development
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    SKIP_PASSWORD_AUTH: noPasswordAuth ? 'true' : 'false'
  };

  // Run the application using yarn and tsx
  appProcess = spawn('yarn', ['tsx', 'src/index.ts'], {
    stdio: 'inherit',
    shell: true,
    env: env
  });

  // Handle process exit
  appProcess.on('exit', (code) => {
    if (!isRestarting) {
      if (code !== 0) {
        console.error(`\nApplication exited with code ${code}`);
      } else {
        console.log('\nApplication closed normally');
      }
      // Use a clean exit without trying to access TTY
      setTimeout(() => {
        process.exit(code);
      }, 100);
    }
  });
}

// Check if a file should trigger a restart
function shouldRestartOnChange(filename) {
  if (!filename) return false;

  // Check file extension
  return watchExtensions.some(ext => filename.endsWith(ext));
}

// Debounced restart function to prevent multiple rapid restarts
function debouncedRestart(filename) {
  console.log(`\n\nFile changed: ${filename}`);
  console.log(`Waiting for changes to settle before restarting...`);

  // Clear any existing timer
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  // Set a new timer
  debounceTimer = setTimeout(() => {
    console.log(`Restarting application now...`);
    restartApp();
    debounceTimer = null;
  }, DEBOUNCE_TIME);
}

// Watch files for changes
async function watchFiles() {
  console.log('Watching for file changes...');

  // Watch each directory
  for (const dir of watchDirs) {
    if (!fs.existsSync(dir)) {
      console.log(`Warning: Directory ${dir} does not exist, skipping watch`);
      continue;
    }

    try {
      console.log(`Watching directory: ${dir}`);
      const watcher = await watch(dir, { recursive: true });

      for await (const event of watcher) {
        if (shouldRestartOnChange(event.filename)) {
          debouncedRestart(event.filename);
        }
      }
    } catch (err) {
      console.error(`Error watching directory ${dir}:`, err);
    }
  }
}

// Restart the application
function restartApp() {
  if (isRestarting) return;
  isRestarting = true;

  // Mark that this is a reload by writing to the state file
  try {
    const statePath = path.join(os.homedir(), '.tame', 'dev-state.json');

    // Read current state if it exists
    let state = {};
    if (fs.existsSync(statePath)) {
      state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    }

    // Ensure the isReload flag is set
    state.isReload = true;
    state.isDevMode = true;

    // Write the state back
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    // Don't log this to keep output clean
  } catch (error) {
    console.error("Error marking reload state:", error);
  }

  // Kill the current process
  if (appProcess) {
    appProcess.kill('SIGKILL'); // Use SIGKILL for more reliable termination

    // Give process time to exit
    setTimeout(() => {
      startApp();
      isRestarting = false;
    }, 1000);
  } else {
    startApp();
    isRestarting = false;
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('\nShutting down development server...');
  if (appProcess) {
    appProcess.kill('SIGKILL'); // Use SIGKILL for more reliable termination
  }
  // Clean exit without immediate TTY access
  setTimeout(() => {
    process.exit(0);
  }, 100);
});

// Start everything
startApp();
watchFiles();
