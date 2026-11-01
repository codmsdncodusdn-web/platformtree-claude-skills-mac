#!/usr/bin/env node
// cut.mjs — 군말·무음·NG 테이크 자동 컷 (외부 npm 의존성 없음)
// 사용법: node cut.mjs <명령> [인자] [--옵션 값]
// 명령: doctor, transcribe, plan, apply

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const WHISPER_TAG = 'b5130'; // whisper.cpp v1.9.4
const WHISPER_MODEL = 'ggml-large-v3-turbo-q5_0.bin';
const WHISPER_MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${WHISPER_MODEL}`;
const WHISPER_WIN_ZIP = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-x64.zip`;

const HOME = os.homedir();
const STATE = path.join(HOME, '.platformtree-skills');
// 릴스 편집 스킬 팩을 이미 설치했다면 그 엔진·모델을 그대로 쓴다 (570MB 중복 다운로드 방지)
const STATE_DIRS = [STATE, path.join(HOME, '.reel-skills')];
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const ME = 'node cut.mjs';

// Mac: Claude 데스크톱 앱 같은 GUI 앱은 PATH가 짧아서 brew로 깐 ffmpeg·node를 못 찾는다 → 흔한 brew 경로를 PATH 앞에 붙인다
if (IS_MAC) {
  const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
  const cur = (process.env.PATH || '').split(path.delimiter);
  process.env.PATH = [...extra.filter((d) => !cur.includes(d) && fs.existsSync(d)), ...cur].join(path.delimiter);
}

// 강도별 무음 기준(초)과 컷 앞뒤 여유(초)
const LEVELS = { 약: { gap: 0.6, pad: 0.08 }, 중: { gap: 0.4, pad: 0.06 }, 강: { gap: 0.25, pad: 0.04 } };
const LEVEL_ALIAS = { soft: '약', normal: '중', tight: '강', 약하게: '약', 보통: '중', 세게: '강', 강하게: '강' };

// 이 글자들로만 된 말은 거의 항상 군말, 아래 목록은 문맥을 봐야 하는 말
const FILLER_SURE = /^[어음으엄흠]+$/;
const FILLER_MAYBE = new Set(['그', '저', '아', '에', '이제', '뭐', '막', '약간', '그니까', '그러니까', '뭐지', '저기']);
// Whisper는 군말을 빼고 받아쓰는 버릇이 있어서, 군말이 섞인 예시 문장을 프롬프트로 주면 더 잘 받아쓴다
const FILLER_PROMPT = '음... 어... 그, 저기, 음.';

// ───────────────────────── 공통 도우미 ─────────────────────────

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > 0) opt[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opt[a.slice(2)] = argv[++i];
      else opt[a.slice(2)] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

function die(msg, hint) {
  console.error(`\n❌ ${msg}`);
  if (hint) console.error(`👉 ${hint}`);
  process.exit(1);
}
const ok = (m) => console.log(`✅ ${m}`);
const info = (m) => console.log(`   ${m}`);
const warn = (m) => console.log(`⚠️  ${m}`);

function run(cmd, args, { capture = false, cwd, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true,
  });
  if (r.error && !allowFail) die(`${cmd} 실행 실패: ${r.error.message}`, `${cmd}가 설치돼 있는지 확인하세요: ${ME} doctor`);
  if (r.status !== 0 && !allowFail) {
    const tail = ((r.stderr || '') + (r.stdout || '')).trim().split('\n').slice(-12).join('\n');
    die(`${path.basename(cmd)} 명령이 실패했어요 (코드 ${r.status})\n${tail}`);
  }
  return r;
}

const has = (cmd, args = ['-version']) => {
  const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true });
  return !r.error && r.status === 0;
};

const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJSON = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8'); };
const r3 = (x) => Math.round(x * 1000) / 1000;
const fmtT = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, '0')}`;
const clean = (w) => w.replace(/[.,?!…~\s]/g, '');

function ffmpegMajor() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true });
  const m = /ffmpeg version n?(\d+)/.exec(r.stdout || '');
  return m ? Number(m[1]) : 0;
}

const STD_FPS = [[24000, 1001], [24, 1], [25, 1], [30000, 1001], [30, 1], [50, 1], [60000, 1001], [60, 1]];

function fpsOf(v) {
  const parse = (s) => { const [n, d] = String(s || '0/1').split('/').map(Number); return d ? n / d : 0; };
  const raw = parse(v?.avg_frame_rate) || parse(v?.r_frame_rate) || 30;
  // 휴대폰 영상은 프레임 간격이 들쭉날쭉(VFR)해서 가장 가까운 표준 값으로 맞춘다
  const [num, den] = STD_FPS.reduce((b, f) => (Math.abs(f[0] / f[1] - raw) < Math.abs(b[0] / b[1] - raw) ? f : b));
  return { num, den };
}

function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file], { capture: true });
  const j = JSON.parse(r.stdout);
  const v = j.streams.find((s) => s.codec_type === 'video');
  const a = j.streams.find((s) => s.codec_type === 'audio');
  let w = v?.width || 0, h = v?.height || 0;
  const rot = Number(v?.tags?.rotate || v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation || 0);
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  return {
    w, h, dur: Number(j.format.duration || 0), fps: fpsOf(v), hasVideo: !!v, hasAudio: !!a,
    sampleRate: Number(a?.sample_rate || 48000), channels: Number(a?.channels || 2),
  };
}

async function download(url, dest, label) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) die(`${label} 다운로드 실패 (HTTP ${res.status})`, `인터넷 연결을 확인하고 다시 실행하세요. 주소: ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  let got = 0, last = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => {
    got += c.length;
    if (total && got - last > total / 20) { last = got; process.stdout.write(`\r   ${label} ${Math.round((got / total) * 100)}%   `); }
  });
  const tmp = dest + '.part';
  await pipeline(body, fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
  process.stdout.write(`\r   ${label} 100%      \n`);
}

function workdirOf(p) {
  if (!p) die('작업 폴더를 지정하세요.', `예: ${ME} plan "C:/영상/촬영본_cut"`);
  const d = path.resolve(p);
  if (!fs.existsSync(path.join(d, 'meta.json'))) die(`작업 폴더가 아니에요: ${d}`, `먼저 ${ME} transcribe "<영상 파일>"을 실행하세요.`);
  return d;
}

// ───────────────────────── doctor ─────────────────────────

function whisperCli() {
  if (process.env.CUT_WHISPER_CLI && fs.existsSync(process.env.CUT_WHISPER_CLI)) return process.env.CUT_WHISPER_CLI;
  const cands = IS_WIN
    ? STATE_DIRS.flatMap((d) => [path.join(d, 'whisper', 'bin', 'Release', 'whisper-cli.exe'), path.join(d, 'whisper', 'bin', 'whisper-cli.exe')])
    : ['/opt/homebrew/bin/whisper-cli', '/usr/local/bin/whisper-cli', ...STATE_DIRS.map((d) => path.join(d, 'whisper', 'bin', 'whisper-cli'))];
  const found = cands.find((p) => fs.existsSync(p));
  if (found || IS_WIN) return found || null;
  const r = spawnSync('which', ['whisper-cli'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

const whisperModel = () => STATE_DIRS.map((d) => path.join(d, 'whisper', 'models', WHISPER_MODEL)).find((p) => fs.existsSync(p)) || null;

async function cmdDoctor({ opt }) {
  const fix = !!opt.fix;
  let bad = 0;
  console.log(`\n🩺 컷편집 스킬 환경 점검 ${fix ? '(자동 설치 모드)' : ''}\n`);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor >= 18) ok(`Node.js ${process.versions.node}`);
  else { bad++; console.log(`❌ Node.js ${process.versions.node} — 18 이상이 필요해요`); info(IS_WIN ? 'winget install OpenJS.NodeJS.LTS' : 'brew install node'); }

  if (has('ffmpeg') && has('ffprobe')) {
    const v = ffmpegMajor();
    if (v && v < 6) { bad++; console.log(`❌ FFmpeg ${v}.x — 6 이상이 필요해요`); }
    else ok(`FFmpeg ${v || ''}`);
  } else { bad++; console.log('❌ FFmpeg 없음'); info(IS_WIN ? '설치: winget install Gyan.FFmpeg  (설치 후 Claude 앱을 껐다 켜세요)' : '설치: brew install ffmpeg  (brew가 없으면 https://brew.sh 먼저 설치)'); }

  const wdir = path.join(STATE, 'whisper');
  let cli = whisperCli();
  if (!cli && fix) {
    if (IS_WIN) {
      const zip = path.join(wdir, 'whisper-bin-x64.zip');
      await download(WHISPER_WIN_ZIP, zip, `whisper.cpp ${WHISPER_TAG}`);
      const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
      const dest = path.join(wdir, 'bin'); fs.mkdirSync(dest, { recursive: true });
      const r = run(fs.existsSync(tar) ? tar : 'tar', ['-xf', zip, '-C', dest], { allowFail: true, capture: true });
      if (r.status !== 0) run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Force -LiteralPath '${zip}' -DestinationPath '${dest}'`], { capture: true });
      fs.rmSync(zip, { force: true });
    } else if (IS_MAC && has('brew', ['--version'])) {
      run('brew', ['install', 'whisper-cpp']);
    } else warn('받아쓰기 엔진을 자동 설치할 수 없어요. https://github.com/ggml-org/whisper.cpp#building');
    cli = whisperCli();
  }
  if (cli) ok('받아쓰기 엔진 whisper.cpp');
  else { bad++; console.log('❌ 받아쓰기 엔진(whisper.cpp) 없음'); info(IS_MAC ? 'brew install whisper-cpp 또는 doctor --fix' : `자동 설치: ${ME} doctor --fix`); }

  if (!whisperModel() && fix) await download(WHISPER_MODEL_URL, path.join(wdir, 'models', WHISPER_MODEL), '한국어 받아쓰기 모델(약 570MB)');
  if (whisperModel()) ok('한국어 받아쓰기 모델 (large-v3-turbo)');
  else { bad++; console.log('❌ 받아쓰기 모델 없음 (약 570MB)'); info(`자동 설치: ${ME} doctor --fix`); }

  console.log(bad ? `\n⛔ 해결이 필요한 항목 ${bad}개` : '\n🎉 준비 완료! 이제 영상을 넣으면 군말을 잘라 드려요.');
  process.exit(bad ? 1 : 0);
}

// ───────────────────────── transcribe ─────────────────────────

function linesOf(words) {
  const lines = []; let cur = [];
  words.forEach((w, k) => {
    cur.push(w);
    const nx = words[k + 1];
    if (!nx || /[.?!]$/.test(w.w) || nx.s - w.e > 0.5 || cur.length >= 14) { lines.push(cur); cur = []; }
  });
  return lines;
}

function writeTranscript(wd, words, file) {
  const out = linesOf(words).map((l, n) => `L${String(n + 1).padStart(2, '0')} [${l[0].i}-${l.at(-1).i}] ${fmtT(l[0].s)}–${fmtT(l.at(-1).e)}  ${l.map((w) => w.w).join(' ')}`);
  fs.writeFileSync(path.join(wd, file), out.join('\n') + '\n', 'utf8');
  return out;
}

// Whisper의 단어 구간(offsets)은 0.3~0.5초씩 어긋나서 그대로 자르면 엉뚱한 곳이 잘린다.
// DTW 시각은 토큰이 끝나는 쯤을 가리키므로 → 끝 = 마지막 토큰 DTW, 시작 = 첫 토큰 직전의 마지막 무음 끝(없으면 앞 단어 끝).
function timeWords(segs, offset, quiet, dur) {
  const isPunct = (txt) => /^[\s.,?!…~"'“”‘’]+$/.test(txt);
  const quietEndBefore = (t) => { let r = -1; for (const [, y] of quiet) { if (y <= t) r = y; else break; } return r; };
  const inQuiet = (t) => quiet.find(([x, y]) => t > x && t < y);
  const out = []; let prevE = 0;
  for (const seg of segs) {
    const w = seg.text.trim();
    if (!w || /^\[_/.test(w)) continue;
    const dt = (seg.tokens || []).filter((k) => !/^\[_/.test(k.text) && !isPunct(k.text) && k.t_dtw >= 0).map((k) => k.t_dtw / 100 + offset);
    let s, e;
    if (!dt.length) { s = seg.offsets.from / 1000 + offset; e = seg.offsets.to / 1000 + offset; }
    else {
      e = dt.at(-1) + 0.06;
      const q = inQuiet(e); if (q) e = q[0] + 0.02;
      s = Math.max(prevE, quietEndBefore(dt[0] - 0.03));
      if (e - s < 0.08) e = s + 0.08;
    }
    // Whisper는 마지막 단어 끝을 30초 창 끝까지 늘리기도 해서 영상 길이로 자른다
    s = Math.min(s, dur); e = Math.min(e, dur);
    if (s >= dur - 0.05) continue;
    out.push({ w, s, e });
    prevE = e;
  }
  // 같은 단어가 3번 이상 연달아 나오면 Whisper가 반복 루프에 빠진 것 → 하나만 남긴다
  return out.filter((t, k) => !(k > 0 && clean(t.w) === clean(out[k - 1].w) && (clean(out[k + 1]?.w || '') === clean(t.w) || (k > 1 && clean(out[k - 2].w) === clean(t.w)))));
}

function cmdTranscribe({ pos, opt }) {
  const src = pos[0] && path.resolve(pos[0]);
  if (!src || !fs.existsSync(src)) die(`영상 파일을 찾을 수 없어요: ${pos[0] || '(없음)'}`, `예: ${ME} transcribe "C:/영상/촬영본.mp4"`);
  const v = probe(src);
  if (!v.hasVideo) die('영상 트랙이 없는 파일이에요.', '말하는 영상(mp4·mov)을 넣어 주세요.');
  if (!v.hasAudio) die('소리가 없는 영상이에요.', '군말을 찾으려면 목소리가 녹음된 영상이 필요해요.');
  const cli = whisperCli(), model = whisperModel();
  if (!cli || !model) die('받아쓰기 엔진이 준비되지 않았어요.', `${ME} doctor --fix 를 먼저 실행하세요.`);

  const name = path.basename(src, path.extname(src));
  const wd = path.resolve(opt.out || path.join(path.dirname(src), `${name}_cut`));
  fs.mkdirSync(wd, { recursive: true });
  const wav = path.join(wd, 'audio.wav');
  console.log(`🎬 소리 추출 중… (${v.w}x${v.h}, ${v.dur.toFixed(1)}초)`);
  run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1', '-ar', '16000', wav]);
  writeJSON(path.join(wd, 'meta.json'), { source: src, name, w: v.w, h: v.h, dur: r3(v.dur), fps: v.fps, sampleRate: v.sampleRate, channels: v.channels, created: new Date().toISOString() });

  const prompt = [opt['no-filler-prompt'] ? '' : FILLER_PROMPT, typeof opt.prompt === 'string' ? opt.prompt : ''].filter(Boolean).join(' ');
  console.log('🎙️  받아쓰는 중… (1분 영상 기준 약 1분)');
  const t0 = Date.now();
  // Whisper는 앞부분 무음이 길면 첫 단어들 시간을 0초 쪽으로 당겨 버려서, 말 시작 직전부터 받아쓰게 한다
  const lead = silences(wav, -35, 0.3).find(([a]) => a < 0.05);
  const offset = lead ? Math.max(0, lead[1] - 0.3) : 0;
  const input = offset > 0 ? path.join(wd, '.whisper_in.wav') : wav;
  if (offset > 0) run('ffmpeg', ['-v', 'error', '-y', '-ss', offset.toFixed(3), '-i', wav, input]);
  const outBase = path.join(wd, '.whisper');
  const threads = String(Math.max(4, Math.min(8, os.cpus().length - 2)));
  // -nfa: flash attention이 켜져 있으면 DTW(정밀 단어 시간)가 조용히 꺼진다
  const args = ['-m', model, '-l', 'ko', '-f', input, '-ojf', '-of', outBase, '-ml', '1', '-sow', '-dtw', 'large.v3.turbo', '-nfa', '-t', threads, '-np'];
  if (prompt) args.push('--prompt', prompt);
  run(cli, args, { capture: true });
  const j = readJSON(outBase + '.json', null);
  if (!j) die('받아쓰기 결과 파일을 읽지 못했어요.');
  fs.rmSync(outBase + '.json', { force: true });
  if (offset > 0) fs.rmSync(input, { force: true });
  const words = timeWords(j.transcription, offset, silences(wav, -35, 0.05), v.dur).map((t, i) => ({ i, w: t.w, s: r3(t.s), e: r3(t.e) }));
  if (!words.length) die('알아들은 말이 없어요.', '목소리가 너무 작거나 한국어가 아닌지 확인하세요.');
  writeJSON(path.join(wd, 'words.json'), { dur: r3(v.dur), words });
  const lines = writeTranscript(wd, words, 'transcript.txt');
  ok(`받아쓰기 완료 (단어 ${words.length}개, ${((Date.now() - t0) / 1000).toFixed(0)}초) → ${wd}`);
  console.log(lines.join('\n'));
  info(`\n다음: ${ME} plan "${wd}"`);
}

// ───────────────────────── plan ─────────────────────────

function silences(wav, noise, minDur) {
  const r = run('ffmpeg', ['-hide_banner', '-nostats', '-i', wav, '-af', `silencedetect=noise=${noise}dB:d=${minDur}`, '-f', 'null', '-'], { capture: true });
  const out = []; let s = null;
  for (const line of r.stderr.split('\n')) {
    let m = /silence_start: ([\d.]+)/.exec(line); if (m) s = Number(m[1]);
    m = /silence_end: ([\d.]+)/.exec(line); if (m && s !== null) { out.push([s, Number(m[1])]); s = null; }
  }
  return out;
}

// 10ms 단위 음량(dB) — 16kHz 모노 16비트 wav를 직접 읽는다
function envelope(wav) {
  const buf = fs.readFileSync(wav);
  let off = 12, data = -1, len = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), n = buf.readUInt32LE(off + 4);
    if (id === 'data') { data = off + 8; len = Math.min(n, buf.length - data); break; }
    off += 8 + n + (n & 1);
  }
  if (data < 0) die('audio.wav를 읽지 못했어요.', `${ME} transcribe를 다시 실행하세요.`);
  const hop = 160, env = new Float32Array(Math.floor(len / 2 / hop));
  for (let k = 0; k < env.length; k++) {
    let s = 0;
    for (let j = 0; j < hop; j++) { const v = buf.readInt16LE(data + (k * hop + j) * 2) / 32768; s += v * v; }
    env[k] = 10 * Math.log10(s / hop + 1e-10);
  }
  return env;
}

// [a,b] 안에서 무음이 아닌(소리가 나는) 부분들
function voicedParts(a, b, sil) {
  const out = []; let cur = a;
  for (const [x, y] of sil) {
    if (y <= cur || x >= b) continue;
    if (x > cur) out.push([cur, x]);
    cur = Math.max(cur, y);
  }
  if (cur < b) out.push([cur, b]);
  return out;
}

function cmdPlan({ pos, opt }) {
  const wd = workdirOf(pos[0]);
  const meta = readJSON(path.join(wd, 'meta.json'));
  const { words } = readJSON(path.join(wd, 'words.json'), { words: [] });
  if (!words.length) die('받아쓴 단어가 없어요.', `먼저 ${ME} transcribe "<영상 파일>"을 실행하세요.`);
  const lv = LEVEL_ALIAS[opt.level] || opt.level || '중';
  if (!LEVELS[lv]) die(`강도는 약·중·강 중 하나예요: ${opt.level}`);
  const gap = Number(opt.gap ?? LEVELS[lv].gap), pad = Number(opt.pad ?? LEVELS[lv].pad), noise = Number(opt.noise ?? -35);
  const wav = path.join(wd, 'audio.wav');
  const dur = meta.dur;

  // 1) 무음 빼고 남길 구간
  const sil = silences(wav, noise, gap);
  const keep = []; let cur = Math.max(0, words[0].s - pad);
  for (const [a, b] of sil) {
    if (b <= cur) continue;
    if (a <= cur + 0.02) { cur = Math.max(cur, b - pad); continue; }
    keep.push([cur, Math.min(a + pad, dur)]); cur = Math.max(b - pad, a + pad);
  }
  const lastEnd = Math.min(dur, words.at(-1).e + pad + 0.15);
  if (cur < lastEnd) keep.push([cur, lastEnd]);
  const fixed = keep.map(([a, b]) => [r3(a), r3(Math.min(b, lastEnd))]).filter(([a, b]) => b - a > 0.08);

  // 2) 받아쓴 군말
  const ctx = (i) => words.slice(Math.max(0, i - 2), i + 3).map((w) => (w.i === i ? `[${w.w}]` : w.w)).join(' ');
  const fillers = words
    .filter((w) => w.e - w.s < 0.9 && (FILLER_SURE.test(clean(w.w)) || FILLER_MAYBE.has(clean(w.w))))
    .map((w) => ({ i: w.i, w: w.w, sure: FILLER_SURE.test(clean(w.w)), context: ctx(w.i) }));

  // 3) 받아쓰기엔 없는데 소리가 나는 틈
  //    - 앞뒤가 무음으로 떨어진 짧은 소리 → Whisper가 빼먹은 "음…", "어…"일 가능성이 높다
  //    - 단어에 붙은 0.8초 이상의 소리 → 받아쓰지 못한 말(같은 문장을 반복하면 Whisper가 하나로 합친다)
  //    - 단어에 붙은 짧은 소리는 대개 단어 끝소리라 후보에서 뺀다
  const fine = silences(wav, noise, 0.05);
  const hidden = [];
  for (let k = 0; k + 1 < words.length; k++) {
    const a = words[k].e, b = words[k + 1].s;
    if (b - a < 0.25) continue;
    const raw = voicedParts(a, b, fine).filter(([x, y]) => y - x >= 0.12);
    if (!raw.length) continue;
    const touches = raw[0][0] <= a + 0.001 || raw.at(-1)[1] >= b - 0.001;
    let s, e, kind;
    if (!touches) { s = raw[0][0] - 0.02; e = raw.at(-1)[1] + 0.02; kind = '군말 소리'; }
    else {
      // 앞 단어 끝소리·뒤 단어 첫소리를 보호하려고 양쪽에 여유를 둔다
      s = Math.max(raw[0][0], a + 0.08); e = Math.min(raw.at(-1)[1], b - 0.05); kind = '받아쓰지 못한 말';
      if (e - s < 0.8) continue;
    }
    if (e - s < 0.15 || e - s > 4) continue;
    hidden.push({ id: `h${hidden.length + 1}`, kind, s: r3(s), e: r3(e), context: `${words.slice(Math.max(0, k - 1), k + 1).map((w) => w.w).join(' ')} [?] ${words.slice(k + 1, k + 3).map((w) => w.w).join(' ')}` });
  }

  // 4) 같은 말로 시작하고 단어가 절반 이상 겹치는 문장이 20초 안에 다시 나오면 앞 테이크를 NG로 본다
  const lines = linesOf(words);
  const retakes = [];
  const bag = (l) => new Set(l.map((w) => clean(w.w)));
  const similar = (l, m) => {
    if (clean(l[0].w) !== clean(m[0].w)) return false;
    const a = bag(l), b = bag(m);
    return [...a].filter((x) => b.has(x)).length / Math.min(a.size, b.size) >= 0.5;
  };
  lines.forEach((l, n) => {
    for (let m = n + 1; m < lines.length && lines[m][0].s - l.at(-1).e < 20; m++) {
      if (l.length >= 2 && similar(l, lines[m])) { retakes.push({ drop: [l[0].i, l.at(-1).i], text: l.map((w) => w.w).join(' '), keptLater: lines[m].map((w) => w.w).join(' ') }); break; }
    }
  });

  const prev = opt.reset ? {} : readJSON(path.join(wd, 'edl.json'), {});
  const autoDrop = fillers.filter((f) => f.sure).map((f) => [f.i, f.i]);
  const edl = {
    level: lv, keep: fixed,
    dropWords: prev.dropWords ?? autoDrop, dropTimes: prev.dropTimes ?? [],
    params: { gap, pad, noise }, suggestions: { fillers, hidden, retakes },
  };
  writeJSON(path.join(wd, 'edl.json'), edl);

  const total = fixed.reduce((s, [a, b]) => s + b - a, 0);
  ok(`컷 계획 (강도 ${lv}): ${dur.toFixed(1)}초 → ${total.toFixed(1)}초 (무음 ${Math.max(0, fixed.length - 1)}곳 제거) → edl.json`);
  if (fillers.length) {
    console.log('\n💬 군말 후보 (단어 번호:말 … 앞뒤 문맥)');
    fillers.forEach((f) => info(`${f.sure ? '[자동 삭제]' : '[문맥 확인]'} ${f.i}:${f.w} … ${f.context}`));
  }
  if (hidden.length) {
    console.log('\n🫥 받아쓰기엔 없지만 소리가 나는 틈');
    hidden.forEach((h) => info(`${h.id} [${h.kind}] ${fmtT(h.s)}–${fmtT(h.e)} (${(h.e - h.s).toFixed(1)}초) … ${h.context}`));
  }
  if (retakes.length) {
    console.log('\n🔁 다시 말한 것으로 보이는 문장 (앞 테이크 삭제 추천)');
    retakes.forEach((r) => info(`단어 [${r.drop[0]}-${r.drop[1]}] "${r.text}"  → 뒤에서 다시: "${r.keptLater}"`));
  }
  if (prev.dropWords) info('\n(이전에 정한 dropWords·dropTimes를 그대로 유지했어요. 처음부터 다시 정하려면 --reset)');
  else info(`\n[자동 삭제] ${autoDrop.length}개는 dropWords에 미리 넣어 뒀어요.`);
  info('edl.json의 "dropWords"에 [시작번호, 끝번호], "dropTimes"에 "h1" 같은 틈 번호를 넣고 apply를 실행하세요.');
  info(`다음: ${ME} apply "${wd}"`);
}

// ───────────────────────── apply ─────────────────────────

function subtract(ranges, holes) {
  let out = ranges.map((r) => [...r]);
  for (const [hs, he] of holes) {
    const next = [];
    for (const [a, b] of out) {
      if (he <= a || hs >= b) next.push([a, b]);
      else { if (hs > a) next.push([a, hs]); if (he < b) next.push([he, b]); }
    }
    out = next;
  }
  return out.filter(([a, b]) => b - a >= 0.12);
}

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function pathUrl(p) {
  const segs = path.resolve(p).split(path.sep).map((seg, k) => (k === 0 && /^[A-Za-z]:$/.test(seg) ? `${seg[0]}%3a` : encodeURIComponent(seg)));
  return 'file://localhost/' + segs.join('/').replace(/^\/+/, '');
}

// 프리미어 프로·다빈치 리졸브가 읽는 Final Cut Pro 7 XML (원본 파일을 그대로 참조하는 시퀀스)
function writeXml(meta, ranges, out) {
  const { num, den } = meta.fps;
  const fps = num / den;
  const rate = `<rate><timebase>${Math.round(fps)}</timebase><ntsc>${den === 1001 ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const F = (t) => Math.round(t * fps);
  const srcDur = F(meta.dur);
  let acc = 0;
  const clips = ranges.map(([a, b]) => {
    const i = F(a), o = Math.max(F(b), i + 1);
    const c = { in: i, out: o, start: acc, end: acc + o - i };
    acc = c.end;
    return c;
  });
  const fname = xmlEsc(path.basename(meta.source));
  const atracks = Math.min(Math.max(meta.channels, 1), 2);
  const fileFull = `<file id="file-1"><name>${fname}</name><pathurl>${xmlEsc(pathUrl(meta.source))}</pathurl>${rate}<duration>${srcDur}</duration>`
    + `<media><video><samplecharacteristics>${rate}<width>${meta.w}</width><height>${meta.h}</height></samplecharacteristics></video>`
    + `<audio><samplecharacteristics><depth>16</depth><samplerate>${meta.sampleRate}</samplerate></samplecharacteristics><channelcount>${meta.channels}</channelcount></audio></media></file>`;
  const links = (k) => [`<link><linkclipref>clipitem-v${k + 1}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${k + 1}</clipindex></link>`,
    ...Array.from({ length: atracks }, (_, t) => `<link><linkclipref>clipitem-a${t + 1}-${k + 1}</linkclipref><mediatype>audio</mediatype><trackindex>${t + 1}</trackindex><clipindex>${k + 1}</clipindex></link>`)].join('');
  const item = (c, k, id, file, extra) => `<clipitem id="${id}"><name>${fname}</name><enabled>TRUE</enabled><duration>${srcDur}</duration>${rate}`
    + `<start>${c.start}</start><end>${c.end}</end><in>${c.in}</in><out>${c.out}</out>${file}${extra}${links(k)}</clipitem>`;
  const vItems = clips.map((c, k) => item(c, k, `clipitem-v${k + 1}`, k === 0 ? fileFull : '<file id="file-1"/>', '')).join('\n');
  const aTracks = Array.from({ length: atracks }, (_, t) => `<track>\n${clips.map((c, k) => item(c, k, `clipitem-a${t + 1}-${k + 1}`, '<file id="file-1"/>',
    `<sourcetrack><mediatype>audio</mediatype><trackindex>${t + 1}</trackindex></sourcetrack>`)).join('\n')}\n</track>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="4">
<sequence id="sequence-1">
<name>${xmlEsc(meta.name)}_cut</name>
<duration>${acc}</duration>
${rate}
<media>
<video>
<format><samplecharacteristics>${rate}<width>${meta.w}</width><height>${meta.h}</height><pixelaspectratio>square</pixelaspectratio></samplecharacteristics></format>
<track>
${vItems}
</track>
</video>
<audio>
${aTracks}
</audio>
</media>
</sequence>
</xmeml>
`;
  fs.writeFileSync(out, xml, 'utf8');
}

function cmdApply({ pos, opt }) {
  const wd = workdirOf(pos[0]);
  const meta = readJSON(path.join(wd, 'meta.json'));
  const W = readJSON(path.join(wd, 'words.json'), { words: [] }).words;
  const edl = readJSON(path.join(wd, 'edl.json'), null);
  if (!edl) die('컷 계획(edl.json)이 없어요.', `먼저 ${ME} plan "${wd}"를 실행하세요.`);
  if (!fs.existsSync(meta.source)) die(`원본 영상이 옮겨졌거나 지워졌어요: ${meta.source}`, '원본을 제자리에 두고 다시 실행하세요.');

  const hiddenById = Object.fromEntries((edl.suggestions?.hidden || []).map((h) => [h.id, h]));
  const dropWords = (edl.dropWords || []).map(([i0, i1 = i0]) => [Math.max(0, i0), Math.min(i1, W.length - 1)]);
  const dropTimes = (edl.dropTimes || []).map((d) => (typeof d === 'string' ? (hiddenById[d] ? [hiddenById[d].s, hiddenById[d].e] : die(`edl.json의 dropTimes에 없는 틈 번호가 있어요: ${d}`)) : d));
  // Whisper 단어 시간은 조금씩 어긋나서, 자르는 지점을 실제 소리에 맞춘다.
  //  - 지울 말 앞뒤에 무음이 있으면: 소리가 시작·끝나는 곳까지 (늘어진 "음…"의 꼬리까지 지운다)
  //  - 이어 말하는 중이면: 단어 경계 근처에서 가장 조용한 지점
  // 이웃 단어 안으로는 넘어가지 않는다.
  const wav = path.join(wd, 'audio.wav');
  const quiet = silences(wav, edl.params?.noise ?? -35, 0.05);
  const env = envelope(wav);
  const quietest = (a, b) => {
    let best = a, bv = Infinity;
    for (let k = Math.max(0, Math.floor(a * 100)); k <= Math.min(env.length - 1, Math.ceil(b * 100)); k++) if (env[k] < bv) { bv = env[k]; best = k / 100 + 0.005; }
    return best;
  };
  const mid = (w) => (w.s + w.e) / 2;
  const wordHole = (i0, i1) => {
    const prev = W[i0 - 1], next = W[i1 + 1], s0 = W[i0].s, e0 = W[i1].e;
    const qs = quiet.filter(([, y]) => y >= Math.max(s0 - 0.5, prev ? prev.e - 0.03 : 0) && y <= s0 + 0.1).at(-1);
    const a = qs ? qs[1] - 0.02 : quietest(Math.max(s0 - 0.12, prev ? mid(prev) : 0), s0 + 0.08);
    const qe = quiet.find(([x]) => x >= e0 - 0.1 && x <= Math.min(e0 + 0.7, next ? next.s + 0.03 : meta.dur));
    const b = qe ? qe[0] + 0.02 : quietest(e0 - 0.08, Math.min(e0 + 0.12, next ? mid(next) : meta.dur));
    return a < b ? [a, b] : [s0, e0];
  };
  const holes = [...dropWords.map(([i0, i1]) => wordHole(i0, i1)), ...dropTimes];
  const ranges = subtract(edl.keep, holes);
  if (!ranges.length) die('남는 구간이 없어요. edl.json을 확인하세요.');

  const outMp4 = path.join(wd, `${meta.name}_cut.mp4`);
  const fpsExpr = `${meta.fps.num}/${meta.fps.den}`;
  console.log(`✂️  ${ranges.length}개 구간을 이어 붙이는 중… (원본 화질 유지, 1분 영상 기준 약 30초)`);
  const f = []; const lab = [];
  ranges.forEach(([a, b], k) => {
    const d = b - a, fd = Math.min(0.012, d / 4); // 이음새마다 12ms 페이드로 "틱" 소리 방지
    f.push(`[0:v]trim=start=${a.toFixed(3)}:end=${b.toFixed(3)},setpts=PTS-STARTPTS,fps=${fpsExpr}[v${k}]`);
    f.push(`[0:a]atrim=start=${a.toFixed(3)}:end=${b.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:d=${fd.toFixed(3)},afade=t=out:st=${(d - fd).toFixed(3)}:d=${fd.toFixed(3)}[a${k}]`);
    lab.push(`[v${k}][a${k}]`);
  });
  f.push(`${lab.join('')}concat=n=${ranges.length}:v=1:a=1[v][a]`);
  const script = path.join(wd, '.cut.filter');
  fs.writeFileSync(script, f.join(';\n'), 'utf8');
  const fcFlag = ffmpegMajor() >= 7 ? ['-/filter_complex', script] : ['-filter_complex_script', script];
  run('ffmpeg', ['-v', 'error', '-y', '-i', meta.source, ...fcFlag, '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', outMp4]);
  fs.rmSync(script, { force: true });

  const outXml = path.join(wd, `${meta.name}_cut.xml`);
  if (!opt['no-xml']) writeXml(meta, ranges, outXml);

  // 컷 결과 받아쓰기 + 의도치 않게 잘린 단어 찾기
  const starts = []; let acc = 0; for (const [a, b] of ranges) { starts.push(acc); acc += b - a; }
  const mapT = (t) => { for (let k = 0; k < ranges.length; k++) { const [a, b] = ranges[k]; if (t >= a - 0.001 && t <= b + 0.001) return starts[k] + Math.min(Math.max(t - a, 0), b - a); } return null; };
  const dropped = new Set(); for (const [i0, i1] of dropWords) for (let i = i0; i <= i1; i++) dropped.add(i);
  // Whisper 단어 시간은 앞뒤로 번지기 쉬워서, 남은 구간과 0.08초도 안 겹칠 때만 "잘렸다"고 본다
  const kept = [], lost = [];
  for (const w of W) {
    if (dropped.has(w.i)) continue;
    if (w.e <= w.s) { const t = mapT(w.s); if (t === null) lost.push(w); else kept.push({ i: kept.length, w: w.w, s: r3(t), e: r3(t) }); continue; }
    const parts = ranges.map(([a, b]) => [Math.max(a, w.s), Math.min(b, w.e)]).filter(([a, b]) => b > a);
    if (!parts.length || parts.reduce((s, [a, b]) => s + b - a, 0) < Math.min(0.08, (w.e - w.s) / 2)) { lost.push(w); continue; }
    kept.push({ i: kept.length, w: w.w, s: r3(mapT(parts[0][0])), e: r3(mapT(parts.at(-1)[1])) });
  }
  writeTranscript(wd, kept, 'transcript_cut.txt');

  const pct = Math.round((1 - acc / meta.dur) * 100);
  const report = [
    `컷편집 리포트 — ${path.basename(meta.source)}`,
    `강도 ${edl.level || '중'} · 원본 ${fmtT(meta.dur)} → 결과 ${fmtT(acc)} (${pct}% 줄어듦) · 이음새 ${ranges.length - 1}곳`,
    '',
    `삭제한 말 ${dropWords.length}곳`,
    ...dropWords.map(([i0, i1]) => `  ${fmtT(W[i0].s)}  ${W.slice(i0, i1 + 1).map((w) => w.w).join(' ')}`),
    '',
    `삭제한 소리 틈 ${dropTimes.length}곳`,
    ...dropTimes.map(([s, e]) => `  ${fmtT(s)}–${fmtT(e)}`),
    ...(lost.length ? ['', `⚠️ 무음 컷에 같이 잘린 것 같은 단어 ${lost.length}개 (확인 필요)`, ...lost.map((w) => `  ${fmtT(w.s)}  ${w.w}`)] : []),
  ];
  fs.writeFileSync(path.join(wd, 'report.txt'), report.join('\n') + '\n', 'utf8');

  ok(`완성: ${outMp4}`);
  if (!opt['no-xml']) info(`편집툴용 XML: ${outXml}  (프리미어 프로·다빈치 리졸브에서 가져오기)`);
  info(`리포트: ${path.join(wd, 'report.txt')}`);
  console.log('\n' + report.join('\n'));
}

// ───────────────────────── main ─────────────────────────

const CMDS = { doctor: cmdDoctor, transcribe: cmdTranscribe, plan: cmdPlan, apply: cmdApply };
const [cmd, ...rest] = process.argv.slice(2);
if (!CMDS[cmd]) {
  console.log(`컷편집 스킬 — 군말·무음·NG 테이크 자동 컷

  ${ME} doctor [--fix]                     환경 점검 (--fix: 받아쓰기 엔진·모델 자동 설치)
  ${ME} transcribe "<영상>" [--prompt "고유명사"]   받아쓰기 → <영상이름>_cut 작업 폴더
  ${ME} plan "<작업폴더>" [--level 약|중|강]      컷 계획 → edl.json
  ${ME} apply "<작업폴더>" [--no-xml]            컷 적용 → mp4 + XML + 리포트`);
  process.exit(cmd ? 1 : 0);
}
await CMDS[cmd](parseArgs(rest));
