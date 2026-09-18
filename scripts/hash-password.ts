/**
 * Generate the ADMIN_PASSWORD_HASH value.
 *
 *   npm run hash-password            # prompts, input hidden
 *   npm run hash-password -- 'pw'    # non-interactive (leaves shell history)
 */
import { createInterface } from 'node:readline';
import { hashPassword } from '../src/auth/password.ts';

async function prompt(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Suppress echo so the password does not appear on screen.
  const out = process.stdout as NodeJS.WriteStream & { muted?: boolean };
  const write = out.write.bind(out);
  let muted = false;
  (out as unknown as { write: (c: string) => boolean }).write = (chunk: string): boolean =>
    muted && !chunk.includes('\n') ? true : write(chunk);

  const answer = await new Promise<string>((resolve) => {
    rl.question('Password: ', (a) => resolve(a));
    muted = true;
  });
  muted = false;
  (out as unknown as { write: typeof write }).write = write;
  process.stdout.write('\n');
  rl.close();
  return answer;
}

const fromArgv = process.argv[2];
const password = fromArgv ?? (await prompt());

if (!password) {
  process.stderr.write('No password given.\n');
  process.exit(1);
}
if (password.length < 12) {
  process.stderr.write(
    `Refusing: ${password.length} characters. This is the only credential guarding every\n` +
      'balance, transaction and stored bank token on a public URL. Use at least 12.\n',
  );
  process.exit(1);
}

process.stdout.write(`\nADMIN_PASSWORD_HASH=${await hashPassword(password)}\n\n`);
process.stdout.write('Paste that into your environment. The password itself is never stored.\n');
