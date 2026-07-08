#!/usr/bin/env node
try {
  const { main } = await import("../dist/cli.js");
  main();
} catch (err) {
  if (err.code === "ERR_MODULE_NOT_FOUND") {
    console.error(
      "Error: qiniucert is not built. Please run 'npm run build' or reinstall the package."
    );
  } else {
    console.error("Error:", err.message || err);
  }
  process.exit(1);
}
