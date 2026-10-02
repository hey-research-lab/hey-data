import { main } from './cli.js';

// A stopped run is not lost: say so, then stop the way a Ctrl-C would.
process.once('SIGINT', () => {
  process.stderr.write('\nhey-data: stopped. Run the same command again to resume.\n');
  process.exit(130);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`hey-data: ${String(error)}\n`);
    process.exitCode = 6;
  },
);
