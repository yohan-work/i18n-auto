#!/usr/bin/env node
import path from "node:path";
import fs from "node:fs";
import fse from "fs-extra";
import fg from "fast-glob";
import { load } from "cheerio";
import { hideBin } from "yargs/helpers";
import yargs from "yargs/yargs";
import crypto from "node:crypto";
import pLimit from "p-limit";
import * as gtrans from "@vitalets/google-translate-api";
// 다양한 번들 형태 호환: default, translate, default.translate, 자체 함수
const translate = (() => {
  const mod = gtrans;
  if (typeof mod === "function") return mod;
  if (typeof mod.default === "function") return mod.default;
  if (typeof mod.translate === "function") return mod.translate;
  if (mod.default && typeof mod.default.translate === "function")
    return mod.default.translate;
  return null;
})();

const argv = yargs(hideBin(process.argv))
  .option("root", { type: "string", demandOption: true })
  .option("from", { type: "string", default: "kor" })
  .option("to", { type: "string", default: "chn,vtn" })
  .option("scope", { type: "string", default: "esg" })
  .option("provider", {
    type: "string",
    default: "google",
    describe: "번역 제공자: google | argos | libre",
  })
  .option("libre-url", {
    type: "string",
    describe: "LibreTranslate 서버 URL (provider=libre)",
  })
  .option("papago-url", {
    type: "string",
    default: "https://naveropenapi.apigw.ntruss.com/nmt/v1/translation",
    describe: "Papago NMT API URL (provider=papago)",
  })
  .option("files", {
    type: "string",
    describe:
      "쉼표 구분 원문 파일 경로 또는 글롭 패턴(예: kor/esg/**/file.html)",
  })
  .option("node-concurrency", {
    type: "number",
    default: 1,
    describe: "텍스트 노드 번역 동시성(권장 1)",
  })
  .option("req-interval-ms", {
    type: "number",
    default: 800,
    describe: "번역 API 호출 간 최소 간격(ms)",
  })
  .option("retry", {
    type: "number",
    default: 5,
    describe: "429 등 오류 재시도 횟수",
  })
  .option("retry-base-ms", {
    type: "number",
    default: 1000,
    describe: "재시도 기본 대기(ms)",
  })
  .option("page-sleep-ms", {
    type: "number",
    default: 1000,
    describe: "파일 간 대기(ms)",
  })
  .option("dry-run", { type: "boolean", default: false })
  .help()
  .parseSync();

const rootArg = Array.isArray(argv.root)
  ? argv.root[argv.root.length - 1]
  : argv.root;
const projectRoot = path.resolve(rootArg);
const fromLang = Array.isArray(argv.from)
  ? String(argv.from[argv.from.length - 1])
  : String(argv.from || "kor"); // kor
const toInputRaw = Array.isArray(argv.to)
  ? String(argv.to[argv.to.length - 1])
  : String(argv.to || "");
const toLangs = toInputRaw
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean); // [chn, vtn]
const scopeDir = argv.scope; // esg

const cacheDir = path.join(projectRoot, "i18n", "cache");
const glossaryDir = path.join(projectRoot, "i18n", "glossary");
const configPath = path.join(projectRoot, "i18n", "config.json");
let i18nConfig = { ignoreSelectors: [], phraseBlacklist: [] };
try {
  if (fs.existsSync(configPath)) {
    i18nConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  }
} catch {}
const concurrency = Math.max(1, Number(argv["node-concurrency"]) || 1);
const reqIntervalMs = Math.max(0, Number(argv["req-interval-ms"]) || 0);
const retryMax = Math.max(0, Number(argv["retry"]) || 0);
const retryBaseMs = Math.max(0, Number(argv["retry-base-ms"]) || 0);
const pageSleepMs = Math.max(0, Number(argv["page-sleep-ms"]) || 0);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let lastRequestTime = 0;
async function ensureRateLimit() {
  if (reqIntervalMs <= 0) return;
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < reqIntervalMs) {
    await sleep(reqIntervalMs - elapsed);
  }
  lastRequestTime = Date.now();
}

function langCode(target) {
  // Map to ISO codes expected by google-translate-api
  if (target === "chn" || target === "zh" || target === "zh-CN") return "zh-CN";
  if (target === "vtn" || target === "vi" || target === "vi-VN") return "vi";
  if (target === "kor" || target === "ko" || target === "ko-KR") return "ko";
  if (target === "eng" || target === "en" || target === "en-US") return "en";
  return target;
}

function argosLangCode(target) {
  // Argos uses ISO like 'ko', 'zh', 'vi'
  const lc = langCode(target);
  if (lc === "zh-CN") return "zh";
  return lc;
}

function sha1(input) {
  return crypto.createHash("sha1").update(input).digest("hex");
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

async function loadCSVGlossary(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = await fse.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const [source, target] = line.split(",");
      return { source: source?.trim(), target: target?.trim() };
    })
    .filter((r) => r.source && r.target);
}

function applyGlossary(text, glossary) {
  let out = text;
  for (const { source, target } of glossary) {
    // word-boundary-ish replace; keep case-sensitive
    const esc = source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`\\b${esc}\\b`, "g"), target);
  }
  return out;
}

function applyBlacklist(text) {
  let out = text;
  for (const bad of i18nConfig.phraseBlacklist || []) {
    const esc = String(bad).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(esc, "ig"), "").trim();
  }
  return out;
}

async function loadCache(target) {
  const file = path.join(cacheDir, `${target}.json`);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(await fse.readFile(file, "utf8"));
  } catch {
    return {};
  }
}

async function saveCache(target, data) {
  await fse.ensureDir(cacheDir);
  const file = path.join(cacheDir, `${target}.json`);
  await fse.writeFile(file, JSON.stringify(data, null, 2), "utf8");
}

function shouldTranslateNode(node) {
  // Only translate textual content nodes; skip scripts and style
  const tag = node[0]?.tagName?.toLowerCase();
  if (tag === "script" || tag === "style" || tag === "noscript") return false;
  return true;
}

function collectTextNodes($, root) {
  const items = [];
  const ignore = new Set(
    (i18nConfig.ignoreSelectors || []).flatMap((sel) =>
      root.find(sel).toArray()
    )
  );
  root.find("*").each((_, el) => {
    if (ignore.has(el)) return;
    if (!shouldTranslateNode($(el))) return;
    $(el)
      .contents()
      .each((__, child) => {
        if (child.type === "text") {
          const original = child.data ?? "";
          const norm = normalizeText(original);
          if (!norm) return;
          items.push({ el, child, original, norm });
        }
      });
  });
  return items;
}

function rewriteLinks($, $content, targetLang) {
  const langPrefixMap = {
    kor: "/kor/",
    chn: "/chn/",
    vtn: "/vtn/",
    eng: "/eng/",
  };
  const fromPrefix = langPrefixMap[fromLang];
  const toPrefix = langPrefixMap[targetLang] ?? `/${targetLang}/`;
  $content.find("a[href]").each((_, a) => {
    const $a = $(a);
    const href = $a.attr("href");
    if (!href) return;
    if (href.startsWith(fromPrefix)) {
      $a.attr("href", href.replace(fromPrefix, toPrefix));
    }
  });
}

async function translateText(text, target, glossary, cache) {
  const key = sha1(`${normalizeText(text)}::${target}`);
  if (cache[key]) return cache[key];

  const provider = String(argv.provider || "google").toLowerCase();
  if (provider === "google") {
    if (!translate) {
      throw new Error("translate function not available");
    }
    let attempt = 0;
    while (true) {
      try {
        await ensureRateLimit();
        const res = await translate(text, {
          to: langCode(target),
          from: langCode(fromLang),
        });
        let t = res.text;
        t = applyGlossary(t, glossary);
        t = applyBlacklist(t);
        cache[key] = t;
        return t;
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        const is429 = /Too Many Requests|429|rate/i.test(msg);
        if (is429 && attempt < retryMax) {
          const wait =
            retryBaseMs * Math.pow(2, attempt) +
            Math.floor(Math.random() * 300);
          attempt++;
          console.warn(`[429] 재시도 ${attempt}/${retryMax} 대기 ${wait}ms`);
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
  } else if (provider === "argos") {
    // Call python helper
    const { execa } = await import("execa");
    const py = "python3";
    const scriptPath = path.join(
      projectRoot,
      "scripts",
      "py",
      "argos_translate.py"
    );
    const fromLc = argosLangCode(fromLang);
    const toLc = argosLangCode(target);
    const res = await execa(py, [scriptPath, "--from", fromLc, "--to", toLc], {
      input: text,
      timeout: 120000,
    });
    let t = res.stdout || "";
    t = applyGlossary(t, glossary);
    t = applyBlacklist(t);
    cache[key] = t;
    return t;
  } else if (provider === "libre") {
    // Minimal LibreTranslate HTTP call
    const url = argv["libre-url"];
    if (!url) throw new Error("libre-url 필요");
    const { default: fetch } = await import("node-fetch");
    const body = {
      q: text,
      source: argosLangCode(fromLang),
      target: argosLangCode(target),
      format: "text",
    };
    const resp = await fetch(`${url.replace(/\/$/, "")}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`libre ${resp.status}`);
    const data = await resp.json();
    let t = data.translatedText || "";
    t = applyGlossary(t, glossary);
    t = applyBlacklist(t);
    cache[key] = t;
    return t;
  } else if (provider === "papago") {
    const url = argv["papago-url"];
    const { default: fetch } = await import("node-fetch");
    const src = argosLangCode(fromLang); // 'ko'
    const tgt = langCode(target) === "zh-CN" ? "zh-CN" : argosLangCode(target);
    const id = process.env.NCP_APIGW_API_KEY_ID || process.env.PAPAGO_CLIENT_ID;
    const secret =
      process.env.NCP_APIGW_API_KEY || process.env.PAPAGO_CLIENT_SECRET;
    if (!id || !secret)
      throw new Error(
        "Papago API 키가 없습니다 (NCP_APIGW_API_KEY_ID / NCP_APIGW_API_KEY)"
      );

    let attempt = 0;
    while (true) {
      try {
        await ensureRateLimit();
        const params = new URLSearchParams();
        params.set("source", src);
        params.set("target", tgt);
        params.set("text", text);
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "X-NCP-APIGW-API-KEY-ID": id,
            "X-NCP-APIGW-API-KEY": secret,
          },
          body: params.toString(),
        });
        if (!resp.ok) throw new Error(`papago ${resp.status}`);
        const data = await resp.json();
        let t = data?.message?.result?.translatedText || "";
        t = applyGlossary(t, glossary);
        t = applyBlacklist(t);
        cache[key] = t;
        return t;
      } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        const is429 = /Too Many Requests|429|rate|Quota/i.test(msg);
        if (is429 && attempt < retryMax) {
          const wait =
            retryBaseMs * Math.pow(2, attempt) +
            Math.floor(Math.random() * 300);
          attempt++;
          console.warn(
            `[429-papago] 재시도 ${attempt}/${retryMax} 대기 ${wait}ms`
          );
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
  } else {
    throw new Error(`Unknown provider: ${provider}`);
  }
}

// Google 전용: 텍스트 배열 배치 번역으로 호출 수 최소화
async function translateBatchGoogle(texts, target, glossary, cache) {
  const normalized = texts.map((t) => normalizeText(t));
  const keys = normalized.map((t) => sha1(`${t}::${target}`));
  const outputs = new Array(texts.length);

  // 캐시 조회
  let needTranslate = [];
  let mapIdx = [];
  for (let i = 0; i < texts.length; i++) {
    const key = keys[i];
    if (cache[key]) {
      outputs[i] = cache[key];
    } else if (normalized[i]) {
      needTranslate.push(texts[i]);
      mapIdx.push(i);
    } else {
      outputs[i] = texts[i];
    }
  }

  if (needTranslate.length === 0) return outputs;

  // 429 대비: 재시도 포함, ensureRateLimit 한 번만
  let attempt = 0;
  while (true) {
    try {
      await ensureRateLimit();
      const res = await translate(needTranslate, {
        to: langCode(target),
        from: langCode(fromLang),
      });
      // 라이브러리는 배열 입력 시 배열로 반환됨
      const translatedArr = Array.isArray(res) ? res : res.text;
      for (let k = 0; k < mapIdx.length; k++) {
        const outRaw = translatedArr[k]?.text || translatedArr[k] || "";
        const cleaned = applyBlacklist(applyGlossary(outRaw, glossary));
        outputs[mapIdx[k]] = cleaned;
        cache[keys[mapIdx[k]]] = cleaned;
      }
      return outputs;
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const is429 = /Too Many Requests|429|rate/i.test(msg);
      if (is429 && attempt < retryMax) {
        const wait =
          retryBaseMs * Math.pow(2, attempt) + Math.floor(Math.random() * 300);
        attempt++;
        console.warn(
          `[429-batch] 재시도 ${attempt}/${retryMax} 대기 ${wait}ms`
        );
        await sleep(wait);
        continue;
      }
      throw e;
    }
  }
}

async function processOneFile(
  srcHtmlPath,
  targetLang,
  glossary,
  cache,
  dryRun
) {
  const rel = path.relative(projectRoot, srcHtmlPath);
  const targetHtmlPath = srcHtmlPath.replace(
    path.sep + fromLang + path.sep,
    path.sep + targetLang + path.sep
  );

  const html = await fse.readFile(srcHtmlPath, "utf8");
  const $ = load(html, { decodeEntities: false });
  const $content = $("#content");
  if ($content.length === 0) {
    console.warn(`[skip] #content 없음: ${rel}`);
    return;
  }

  // 준비: 대상 파일이 없으면 헤더/푸터 템플릿 복제
  if (!fs.existsSync(targetHtmlPath)) {
    await fse.ensureDir(path.dirname(targetHtmlPath));
    // 언어별 대표 템플릿 탐색: 같은 디렉터리의 첫 HTML 사용
    const dir = path.dirname(targetHtmlPath);
    const candidates = await fg("*.html", { cwd: dir, absolute: true });
    if (candidates.length > 0) {
      await fse.copyFile(candidates[0], targetHtmlPath);
    } else {
      // 최후 수단: 원문 파일 복사 후 언어 마커(class/lang)만 교체 시도
      await fse.copyFile(srcHtmlPath, targetHtmlPath);
    }
  }

  const targetHtml = await fse.readFile(targetHtmlPath, "utf8");
  const $t = load(targetHtml, { decodeEntities: false });
  const $tContent = $t("#content");
  if ($tContent.length === 0) {
    console.warn(
      `[warn] 대상에 #content 없음, 전체 바디 교체를 피하고 원문 구조를 사용: ${path.relative(
        projectRoot,
        targetHtmlPath
      )}`
    );
    $t("body").append('<div id="content"></div>');
  }

  // 번역 대상 텍스트 수집
  const nodes = collectTextNodes($, $content);
  const limit = pLimit(concurrency);
  let translated;
  if (String(argv.provider || "google").toLowerCase() === "google") {
    // Google일 때는 배치 번역로 호출 수 절감
    try {
      const originals = nodes.map((n) => n.original);
      translated = await translateBatchGoogle(
        originals,
        targetLang,
        glossary,
        cache
      );
    } catch (e) {
      console.warn(
        `[translate-batch-fail] ${rel}: ${e.message}. 단건 번역으로 폴백`
      );
      translated = await Promise.all(
        nodes.map(({ original }) =>
          limit(async () => {
            try {
              const t = await translateText(
                original,
                targetLang,
                glossary,
                cache
              );
              return t;
            } catch (err) {
              console.warn(`[translate-fail] ${rel}: ${err.message}`);
              return original;
            }
          })
        )
      );
    }
  } else {
    translated = await Promise.all(
      nodes.map(({ original }) =>
        limit(async () => {
          try {
            const t = await translateText(
              original,
              targetLang,
              glossary,
              cache
            );
            return t;
          } catch (e) {
            console.warn(`[translate-fail] ${rel}: ${e.message}`);
            return original; // 실패 시 원문 유지
          }
        })
      )
    );
  }

  // 번역 결과 적용
  let idx = 0;
  nodes.forEach(({ el, child }) => {
    const t = translated[idx++];
    child.data = t;
  });

  // 링크 언어 경로 치환
  rewriteLinks($, $content, targetLang);

  // 대상 문서의 #content만 교체
  const newContentHtml = $content.html();
  if (argv["dry-run"]) {
    console.log(
      `[dry-run] ${rel} -> ${path.relative(
        projectRoot,
        targetHtmlPath
      )} (#content ${nodes.length} nodes)`
    );
    return;
  }

  const $t2 = load(await fse.readFile(targetHtmlPath, "utf8"), {
    decodeEntities: false,
  });
  const $t2Content = $t2("#content");
  if ($t2Content.length > 0) {
    $t2Content.html(newContentHtml);
  } else {
    $t2("body").append(`<div id="content">${newContentHtml}</div>`);
  }

  // body class/lang 업데이트(가능하면)
  const langClassMap = { chn: "chn", vtn: "vtn", kor: "kor", eng: "eng" };
  const $body = $t2("body");
  if ($body.length) {
    // class
    let classes = ($body.attr("class") || "").split(/\s+/).filter(Boolean);
    classes = classes.filter((c) => !["kor", "chn", "vtn", "eng"].includes(c));
    classes.push(langClassMap[targetLang] || targetLang);
    $body.attr("class", classes.join(" "));
  }
  const $htmlTag = $t2("html");
  if ($htmlTag.length) {
    const langAttr =
      { chn: "zh", vtn: "vi", kor: "ko", eng: "en" }[targetLang] || targetLang;
    $htmlTag.attr("lang", langAttr);
  }

  await fse.writeFile(targetHtmlPath, $t2.html(), "utf8");
}

async function main() {
  await fse.ensureDir(cacheDir);
  await fse.ensureDir(glossaryDir);

  let files = [];
  let patternUsed = "";
  if (argv.files) {
    const patterns = argv.files
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => (path.isAbsolute(p) ? p : path.join(projectRoot, p)));
    const expanded = await Promise.all(
      patterns.map((p) => fg(p.replace(/\\/g, "/"), { absolute: true }))
    );
    files = expanded.flat();
    patternUsed = patterns.join(", ");
  } else {
    patternUsed = path
      .join(projectRoot, fromLang, scopeDir, "**/*.html")
      .replace(/\\/g, "/");
    files = await fg(patternUsed, { absolute: true });
  }
  if (files.length === 0) {
    console.error(`[error] 원문 파일이 없습니다: ${patternUsed}`);
    process.exit(1);
  }

  for (const targetLang of toLangs) {
    const glossaryPath = path.join(glossaryDir, `${targetLang}.csv`);
    const glossary = await loadCSVGlossary(glossaryPath);
    const cache = await loadCache(targetLang);

    for (const src of files) {
      await processOneFile(src, targetLang, glossary, cache, argv["dry-run"]);
      if (!argv["dry-run"] && pageSleepMs > 0) {
        await sleep(pageSleepMs);
      }
    }

    await saveCache(targetLang, cache);
  }
  console.log("i18n sync 완료");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
