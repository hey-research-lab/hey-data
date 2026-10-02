import { main } from './cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`hey-data: ${String(error)}\n`);
    process.exitCode = 6;
  },
);
