import { Browser } from 'ceki-browser';

const br = new Browser({ token: 'YOUR_TOKEN' });
await br.connect();

const s = await br.openSession({ mode: 'persona', domainHints: ['app.example.com'] });
await s.navigate('https://app.example.com/login');

// Inject stored credentials (requires verified provider)
await s.injectCredentials('secret-abc-123', {
  username_selector: '#email',
  password_selector: '#password',
  submit_selector: '#login-btn',
});

// If 2FA is required, ask the browser owner to complete it
const result = await s.requestHumanAction('2fa', 'Please enter the 2FA code from your authenticator app', 120);
console.log(`2FA status: ${result.status}`);

await s.close();
await br.close();
