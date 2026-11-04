const help = 'Usage: node scripts/notify-upcoming-deadlines.cjs --tenant-id UUID [--window-minutes 1440] [--limit 100] [--after-id UUID]\nRuns one explicit maintenance page. Requires a built API and an authorized database environment. No scheduler is installed.\n';

async function main(args) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); return; }
  const { DeadlineNotificationService, parseDeadlineArguments } = require('../dist/modules/communication/deadlines.service.js');
  const input = parseDeadlineArguments(args);
  const result = await new DeadlineNotificationService().run(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('Deadline maintenance failed. Check arguments, migration and authorized server configuration; no successful execution is claimed.\n');
    process.exitCode = 1;
  });
}
module.exports = { main };
