import crypto from 'crypto';
import axios from 'axios';
import express, { Request, Response, NextFunction } from 'express';

// Login do painel da Iara (login único com o CRM, decisão de 26/11):
// usuário e senha são conferidos no CRM (/api/validar-login); a Iara guarda só uma
// sessão assinada por 12 h. Se o CRM estiver fora do ar, vale a senha de emergência
// IARA_SENHA_EMERGENCIA (usuário "admin"), para o Wesley nunca ficar trancado do lado de fora.

const COOKIE = 'iara_sessao';
const DURACAO_MS = 12 * 60 * 60 * 1000;
const PUBLICAS = ['/webhook', '/health', '/status', '/google/', '/login', '/logout', '/favicon.ico'];

function segredo(): string {
  return process.env.IARA_SESSION_SECRET || crypto.createHash('sha256').update('iara:' + (process.env.CRM_API_KEY || process.env.WASPEED_TOKEN || 'x')).digest('hex');
}
function assinar(t: string) { return crypto.createHmac('sha256', segredo()).update(t).digest('base64url'); }
function iguais(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); }

export interface UsuarioPainel { login: string; nome: string; papel: string }

function criarSessao(u: UsuarioPainel): string {
  const dados = Buffer.from(JSON.stringify({ ...u, exp: Date.now() + DURACAO_MS })).toString('base64url');
  return `${dados}.${assinar(dados)}`;
}

export function usuarioDoCookie(cabecalho: string | undefined): UsuarioPainel | null {
  const par = String(cabecalho || '').split(';').map(c => c.trim()).find(c => c.startsWith(COOKIE + '='));
  if (!par) return null;
  const valor = decodeURIComponent(par.slice(COOKIE.length + 1));
  const [dados, assinatura] = valor.split('.');
  if (!dados || !assinatura || !iguais(assinatura, assinar(dados))) return null;
  try {
    const u = JSON.parse(Buffer.from(dados, 'base64url').toString());
    if (!u.exp || u.exp < Date.now()) return null;
    return { login: u.login, nome: u.nome, papel: u.papel };
  } catch { return null; }
}

function cookie(valor: string, maxAgeSeg: number) {
  return `${COOKIE}=${encodeURIComponent(valor)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeg}`;
}

function chaveApi(req: Request): boolean {
  const k = process.env.IARA_API_KEY; const v = req.headers['x-api-key'];
  return !!k && k.length >= 24 && typeof v === 'string' && iguais(v, k);
}

export function exigirLogin(req: Request, res: Response, next: NextFunction) {
  if (PUBLICAS.some(p => req.path === p || (p.endsWith('/') ? req.path.startsWith(p) : req.path.startsWith(p + '/')))) return next();
  if (chaveApi(req)) return next();
  const u = usuarioDoCookie(req.headers.cookie);
  if (u) { (req as any).usuario = u; return next(); }
  if (req.method === 'GET' && String(req.headers.accept || '').includes('text/html')) {
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  return res.status(401).json({ erro: 'Login necessário' });
}

const tentativas = new Map<string, { n: number; ate: number }>();

function pagina(erro = '', next = '/') {
  const e = erro ? `<p class="e">${erro.replace(/</g, '&lt;')}</p>` : '';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Iara — Entrar</title><style>body{font-family:system-ui,sans-serif;background:#f4f6f8;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:16px}form{background:#fff;padding:28px;border-radius:12px;box-shadow:0 2px 12px #0002;width:100%;max-width:340px}h1{margin:0 0 6px;font-size:22px}p.s{color:#555;margin:0 0 18px;font-size:14px}label{display:block;font-size:14px;margin:12px 0 4px}input{width:100%;box-sizing:border-box;padding:11px;border:1px solid #ccc;border-radius:8px;font-size:16px}button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:8px;background:#1a73e8;color:#fff;font-size:16px}.e{color:#c5221f;font-size:14px}</style></head><body><form method="post" action="/login"><h1>Painel da Iara</h1><p class="s">Entre com o mesmo usuário e senha do CRM.</p>${e}<input type="hidden" name="next" value="${next.replace(/"/g, '&quot;')}"><label>Usuário</label><input name="login" autocomplete="username" required autofocus><label>Senha</label><input name="senha" type="password" autocomplete="current-password" required><button type="submit">Entrar</button></form></body></html>`;
}

function proximoSeguro(n: any): string {
  const s = String(n || '/');
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
}

export function registrarRotasLogin(app: express.Express) {
  app.get('/login', (req, res) => res.send(pagina(req.query.erro ? 'Usuário ou senha incorretos.' : '', proximoSeguro(req.query.next))));

  app.post('/login', express.urlencoded({ extended: false }), async (req, res) => {
    const ip = req.ip || '';
    const t = tentativas.get(ip);
    if (t && t.n >= 5 && t.ate > Date.now()) return res.status(429).send(pagina('Muitas tentativas. Aguarde 15 minutos.'));
    const login = String(req.body?.login || '').trim().toLowerCase();
    const senha = String(req.body?.senha || '');
    const next = proximoSeguro(req.body?.next);
    let usuario: UsuarioPainel | null = null;
    let crmFora = false;

    if (process.env.CRM_URL && process.env.CRM_API_KEY) {
      try {
        const r = await axios.post(`${process.env.CRM_URL.replace(/\/$/, '')}/api/validar-login`, { login, senha, ip }, { headers: { 'x-api-key': process.env.CRM_API_KEY }, timeout: 10000, validateStatus: () => true });
        if (r.status === 429) return res.status(429).send(pagina('Muitas tentativas. Aguarde 15 minutos.', next));
        if (r.status >= 500) crmFora = true;
        else if (r.data?.ok) usuario = r.data.usuario;
      } catch { crmFora = true; }
    } else crmFora = true;

    // Emergência: CRM fora do ar → senha local do admin
    const emerg = process.env.IARA_SENHA_EMERGENCIA || '';
    if (!usuario && crmFora && login === 'admin' && emerg.length >= 12 && iguais(senha, emerg)) {
      usuario = { login: 'admin', nome: 'Administrador (emergência)', papel: 'admin' };
      console.warn('[login] entrada com senha de emergência (CRM fora do ar)');
    }

    if (!usuario) {
      const atual = tentativas.get(ip);
      tentativas.set(ip, { n: (atual && atual.ate > Date.now() ? atual.n : 0) + 1, ate: Date.now() + 15 * 60 * 1000 });
      return res.status(401).send(pagina(crmFora ? 'Não foi possível conferir no CRM agora. Tente de novo em instantes.' : 'Usuário ou senha incorretos.', next));
    }
    tentativas.delete(ip);
    console.log(`[login] painel da Iara: ${usuario.login}`);
    res.setHeader('Set-Cookie', cookie(criarSessao(usuario), Math.floor(DURACAO_MS / 1000)));
    res.redirect(next);
  });

  app.get('/logout', (_req, res) => {
    res.setHeader('Set-Cookie', cookie('', 0));
    res.redirect('/login');
  });
}
