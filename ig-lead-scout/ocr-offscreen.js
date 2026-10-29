// ocr-offscreen.js
// Фоновое распознавание текста (Cloud Vision / Tesseract) и речи (Groq Whisper / Local Whisper)
// в offscreen-документе расширения.

const RUSSIAN_ASR_PROMPT =
  'Русская речь, фитнес, тренировки, упражнения, ягодицы, кроссовер, присед, зал, блогеры, Reels, Instagram, питание, рецепты, подходы.';

// ---------- OCR: распознавание текста ----------
let tWorkerPromise = null;

async function getTWorker() {
  if (!tWorkerPromise) {
    tWorkerPromise = (async () => {
      if (typeof Tesseract === 'undefined') {
        throw new Error('Нет файла lib/tesseract.min.js — проверь наличие файлов в папке lib/.');
      }
      let worker;
      try {
        worker = await Tesseract.createWorker(['rus', 'eng'], 1, {
          workerPath: chrome.runtime.getURL('lib/worker.min.js'),
          corePath: chrome.runtime.getURL('lib/'),
          langPath: chrome.runtime.getURL('lib/'),
          workerBlobURL: false,
        });
      } catch (err) {
        console.warn('Не удалось загрузить rus+eng, откатываемся на rus:', err);
        worker = await Tesseract.createWorker('rus', 1, {
          workerPath: chrome.runtime.getURL('lib/worker.min.js'),
          corePath: chrome.runtime.getURL('lib/'),
          langPath: chrome.runtime.getURL('lib/'),
          workerBlobURL: false,
        });
      }
      // PSM 3 (AUTO): полноценный анализ разметки страницы, находит заголовки, списки и подзаголовки
      await worker.setParameters({
        tessedit_pageseg_mode: '3',
        preserve_interword_spaces: '1',
      });
      return worker;
    })().catch((err) => {
      tWorkerPromise = null;
      throw err;
    });
  }
  return tWorkerPromise;
}

// Преобразование любого источника (Blob, URL, dataUrl, Canvas) в HTML5 Canvas через нативный декодер браузера.
// Это навсегда устраняет ошибку Leptonica "Unknown format: no pix returned" для форматов WebP и AVIF!
async function imageSourceToCanvas(imageSource, opts) {
  let imgBitmap = null;
  if (imageSource instanceof Blob) {
    imgBitmap = await createImageBitmap(imageSource);
  } else if (typeof imageSource === 'string') {
    const resp = await fetch(imageSource);
    const b = await resp.blob();
    imgBitmap = await createImageBitmap(b);
  } else if (imageSource instanceof HTMLImageElement || imageSource instanceof HTMLCanvasElement) {
    imgBitmap = await createImageBitmap(imageSource);
  }

  if (!imgBitmap) {
    throw new Error('Не удалось декодировать изображение кадра/слайда.');
  }

  // Мелочь вроде 2×36 px — это не контент, а заглушка: Instagram отдаёт крошечный
  // LQIP-плейсхолдер, пока грузится нормальная картинка, а снимок вкладки может
  // схлопнуться до полоски. Leptonica на таком орёт «Image too small to scale!!»,
  // Tesseract возвращает мусор, а облачный слот (их ~3 в минуту) сожжён впустую.
  // Отсекаем здесь: у этого места два вызывающих пути — и облако, и локальная
  // распознавалка, так что ни один из них не получит заведомо пустую картинку.
  const minDim = Math.min(imgBitmap.width, imgBitmap.height);
  if (minDim < 40 || imgBitmap.width * imgBitmap.height < 6000) {
    const tiny = new Error(
      'Вместо кадра — картинка-заглушка ' + imgBitmap.width + '×' + imgBitmap.height + ' px'
    );
    tiny.tinyImage = true;
    try { imgBitmap.close && imgBitmap.close(); } catch (_) {}
    throw tiny;
  }

  // Tesseract лучше всего распознаёт текст при высоте строки 30-45px.
  // Если разрешение меньше 1400px, масштабируем с высоким качеством сглаживания
  // Для локального Tesseract апскейл полезен (мелкий текст), для нейронки — вреден:
  // больше пикселей = больше входных токенов = меньше картинок в минуту лимита.
  const scaleUp = !opts || opts.scaleUp !== false;
  const maxSide = (opts && opts.maxSide) || 0;
  let scale = 1.0;
  const maxDim = Math.max(imgBitmap.width, imgBitmap.height);
  if (maxSide && maxDim > maxSide) scale = maxSide / maxDim;
  else if (scaleUp && maxDim < 1400) scale = Math.min(2.0, 1600 / maxDim);

  const cnv = document.createElement('canvas');
  cnv.width = Math.max(1, Math.round(imgBitmap.width * scale));
  cnv.height = Math.max(1, Math.round(imgBitmap.height * scale));
  const ctx = cnv.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Не удалось создать 2D-контекст для кадра.');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imgBitmap, 0, 0, cnv.width, cnv.height);
  return cnv;
}

async function imageSourceToDataUrl(imageSource, forCloud, maxSideOverride) {
  if (typeof imageSource === 'string' && imageSource.startsWith('data:image/')) {
    return imageSource;
  }
  const cnv = await imageSourceToCanvas(
    imageSource,
    forCloud ? { scaleUp: false, maxSide: maxSideOverride || CLOUD_MAX_SIDE } : null
  );
  return cnv.toDataURL('image/jpeg', forCloud ? 0.85 : 0.92);
}

// Фильтрация распознанных строк Tesseract: удаление низковероятного фото-мусора
function filterCleanTextLines(data) {
  if (!data) return '';
  const lines = data.lines || [];
  if (!lines.length) {
    return (data.text || '').trim();
  }

  const valid = [];
  for (const line of lines) {
    const raw = (line.text || '').trim();
    if (!raw) continue;

    // Считаем уверенность строки по словам
    let avgConf = 0;
    if (line.words && line.words.length > 0) {
      const sum = line.words.reduce((acc, w) => acc + (w.confidence || 0), 0);
      avgConf = sum / line.words.length;
    } else if (typeof line.confidence === 'number') {
      avgConf = line.confidence;
    } else {
      avgConf = 70;
    }

    if (avgConf < 45) continue;

    const letters = raw.replace(/[^\p{L}\p{N}]/gu, '');
    if (letters.length < 2) continue;

    // В настоящих словах человеческого языка есть гласные буквы
    const hasVowels = /[аеёиоуыэюяaeiouy]/i.test(letters);
    if (!hasVowels && letters.length <= 5 && !/^\d+$/.test(letters)) {
      continue;
    }

    // Короткий шум без гласных или случайные обрывки (типа "LLY", "ws", "NN", "SRS", "wor", "Sex", "2m", "щ =") отсекаем
    if (letters.length <= 3 && !/^[а-яёА-ЯЁ]{2,3}$/.test(letters)) {
      continue;
    }

    valid.push(raw);
  }

  // Исключаем оверлей таймера плеера Instagram (0:00 / 1:07)
  const cleanValid = [];
  for (const line of valid) {
    if (/^\d{1,2}:\d{2}\s*(?:\/|из|of)\s*\d{1,2}:\d{2}$/.test(line)) continue;
    cleanValid.push(line);
  }

  // Если после фильтрации осталось меньше 2 букв суммарно — на фото текста нет
  const totalLetters = cleanValid.join('').replace(/[^\p{L}]/gu, '');
  if (totalLetters.length < 2) {
    return '';
  }

  return cleanValid.join('\n').trim();
}

// Распознавание через Cloud Vision API (Groq Qwen Vision или OpenAI gpt-4o-mini)

// Обычный режим: только текст с картинки, слово в слово.
const OCR_TEXT_PROMPT =
  'Внимательно прочитай изображение и выведи ВЕСЬ видимый текст на русском или английском языке (заголовки, подзаголовки, мелкий поясняющий текст, рецепты, граммовки, цитаты, призывы, надписи на видео). ' +
  'Выведи ТОЛЬКО найденный на картинке текст слово в слово, сохраняя структуру строк. ' +
  'Не пиши ничего от себя, не добавляй комментариев и рассуждений. ' +
  'Если на изображении нет связного текста (только фотография человека, зал, пейзаж без надписей), ответь строго: (нет текста)';

// Режим «видит картинку» (vision): тем же ОДНИМ запросом просим и текст, и
// описание того, что изображено. Отдельный второй запрос не гоним — это удвоило
// бы расход токенов и время на каждый слайд.
// ШАГ 1 повторяет требования обычного промпта: чтение надписей в vision-режиме
// не должно быть хуже, чем в текстовом.
// Прежняя формулировка «опиши 3–5 строками: пол, возраст, обстановку, формат,
// цветовую гамму и настроение» превращала каждый слайд в простыню воды. Теперь
// просим ровно 1–2 предложения и ОБЯЗАТЕЛЬНЫЕ метки «Текст:» / «Что на слайде:»:
// по этим меткам ответ потом раскладывается на два блока (и правка промпта
// пользователем тоже остаётся разборной).
const OCR_VISION_PROMPT =
  'Изображение — слайд или кадр из Instagram. Задача из двух шагов, выполни ОБА. ' +
  'ШАГ 1 (текст): первая строка ответа — «Текст:», дальше выведи ВЕСЬ видимый текст на русском или английском языке (заголовки, подзаголовки, мелкий поясняющий текст, рецепты, граммовки, цитаты, призывы, надписи на видео) слово в слово, сохраняя структуру строк. ' +
  'Если связного текста нет (только фотография человека, зала, пейзажа без надписей), напиши строго одной строкой: (нет текста) — и переходи к шагу 2. ' +
  'ШАГ 2 (описание): с новой строки начни с разделителя «Что на слайде:» и опиши, что изображено, РОВНО одним-двумя короткими предложениями: кто или что в кадре и что происходит. ' +
  'Не пиши про цвета, оттенки, композицию, формат, настроение и качество съёмки и не пересказывай текст с картинки — это вода. Обстановку упоминай только если без неё непонятно, что происходит. ' +
  'Не выдумывай детали, которых не видно. Кроме этих двух блоков не пиши ничего — никаких рассуждений и оценок.';

// Если задан СВОЙ промпт (пользователь отредактировал его в попапе), требование
// формата дописываем поверх: без меток ответ не разложить на «Текст» и «описание».
const VISION_FORMAT_RULE =
  ' Формат ответа строгий: первая строка «Текст:» и весь найденный на картинке текст (или одна строка «(нет текста)»), затем с новой строки «Что на слайде:» — ровно 1–2 коротких предложения о том, что изображено. Никаких других разделов, пояснений и оценок.';

// Промпт для облачного запроса: свой текст либо встроенный по режиму.
function cloudPromptFor(vision, custom) {
  const own = String(custom || '').trim();
  if (!own) return vision ? OCR_VISION_PROMPT : OCR_TEXT_PROMPT;
  return vision ? own + VISION_FORMAT_RULE : own;
}

// Разделитель описания модель пишет по-разному: «[НА ФОТО]», «Описание:»,
// «Что в кадре:»… Ловим все варианты, иначе блок уезжает в «текст».
const VISION_DESC_RE =
  /(?:^|\n)\s*[\[(«]?\s*(?:что\s+(?:на|в)\s+[\wа-яё]+|на\s+(?:фото|слайде|картинке)|описание(?:\s+картинки)?|что\s+изображено)\s*[\])»]?\s*[:—\-–]?\s*/i;
const VISION_TEXT_LABEL_RE =
  /^\s*[\[(«]?\s*(?:текст|ocr|что\s+написано|текст\s+с\s+картинки)\s*[\])»]?\s*[:—\-–]\s*/i;

// Ответ vision-режима всегда приводим к двум блокам: «Текст: …» и «Что на слайде: …».
// Воду режем по границам предложений — максимум два.
function formatVisionAnswer(raw, scene) {
  const s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!s) return '';
  const m = VISION_DESC_RE.exec(s);
  let textPart = (m ? s.slice(0, m.index) : s).replace(VISION_TEXT_LABEL_RE, '').trim();
  let descPart = (m ? s.slice(m.index + m[0].length) : '').replace(/\s+/g, ' ').trim();
  const sents = descPart.match(/[^.!?…]+[.!?…]+|[^.!?…]+$/g);
  // trim у каждого предложения обязателен: иначе join(' ') даёт двойной пробел
  if (sents && sents.length > 2) descPart = sents.slice(0, 2).map((x) => x.trim()).join(' ').trim();
  if (/^\(?\s*нет текста\s*\)?$/i.test(textPart)) textPart = '';
  const out = 'Текст:\n' + (textPart || '(нет текста)');
  return descPart ? out + '\nЧто ' + (scene || 'на слайде') + ': ' + descPart : out;
}

// ---------- Облачные лимиты: очередь и ожидание «окна токенов» ----------
// Groq на бесплатном тарифе ограничивает НЕ число запросов, а входные токены в
// минуту (ITPM ≈ 7000 для этого org-аккаунта). Картинка Instagram стоит
// ~2200-2500 входных токенов, то есть потолок ≈ 3 изображения в минуту.
// Баг был в том, что на 429 код просто «пробовал следующую модель»: модели живут
// в одном аккаунте и упираются в тот же лимит, поэтому вторая попытка давала тот
// же 429, а весь слайд отваливался с ошибкой в консоль. Теперь: ждём ровно
// столько, сколько просит сам сервер, держим облачные запросы по одному и
// заранее помечаем окно занятым, чтобы не долбить сервер заведомым 429.
const CLOUD_BUDGET_MS = 30000; // сколько максимум одна картинка может ждать окно
const CLOUD_RETRY_LIMIT = 3;   // попыток той же модели с backoff
const CLOUD_MAX_SIDE = 1400;   // сторона картинки для нейронки: меньше пикселей = меньше токенов
// Жёсткий таймаут ОДНОГО HTTP-запроса к облаку. Без него «соединение отдало и молчит»
// вешало await fetch навсегда — весь разбор стоял до жёсткого потолка вкладки (15 мин).
// По истечении — Abort → сетевая ветка catch → фолбэк на локалку/Tesseract, а не вечный стой.
const CLOUD_REQ_MS = 45000;
// Жёсткий таймаут одного ASR-запроса (Whisper): клип короткий, дольше минуты висеть не должен.
const ASR_REQ_MS = 60000;

let cloudEstimateIn = 2400; // стоимость одного изображения во входных токенах (уточняется по usage)
let cloudFreeAt = 0;        // раньше этого момента в облако идти смысла нет
let cloudChain = Promise.resolve(); // очередь: облачные запросы идут строго по одному

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Math.round(Number(ms) || 0))));
}

// «11.94s», «2 minutes», «350ms», «12» -> секунды
function cloudDurSec(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s) return 0;
  const num = parseFloat(s.replace(/,/g, '.'));
  if (!isFinite(num)) return 0;
  if (s.includes('ms') || s.includes('милл')) return num / 1000;
  if (s.includes('min') || s.includes('мин')) return num * 60;
  if (s.includes('hr') || s.includes('hour') || s.includes('час')) return num * 3600;
  return num; // «s», «sec», «seconds» или просто число — это секунды
}

// Сколько подождать: берём максимум из retry-after, x-ratelimit-reset-tokens и
// человеческой подсказки в теле ответа («Please try again in 11.94s»). Сервернее
// подсказку игнорировать нельзя: именно она говорит, когда откроется окно токенов.
function cloudWaitSec(res, errText) {
  let best = 0;
  const pick = (v) => {
    const sec = typeof v === 'number' ? v : cloudDurSec(v);
    if (isFinite(sec) && sec > best) best = sec;
  };
  try {
    const h = res && res.headers;
    if (h && h.get) {
      const ra = h.get('retry-after');
      if (ra) {
        const n = Number(ra);
        if (isFinite(n) && n > 0) pick(n);
        else {
          const d = Date.parse(ra);
          if (!isNaN(d)) pick((d - Date.now()) / 1000);
        }
      }
      pick(h.get('x-ratelimit-reset-tokens'));
    }
  } catch (_) {}
  const m = /try again in\s*([\d.,]+\s*(?:ms|s\b|sec\w*|min\w*|hour\w*)?)/i.exec(errText || '');
  if (m) pick(cloudDurSec(m[1]) + 0.5);
  if (!isFinite(best) || best <= 0) best = 3;
  return Math.min(120, best);
}

// Учитываем ответ сервера: реальную цену картинки в токенах и когда закроется
// лимитное окно. Это позволяет не отправлять заведомо проигрышный запрос.
function noteCloudUsage(res, json) {
  try {
    const u = json && json.usage;
    if (u && u.prompt_tokens) {
      cloudEstimateIn = Math.max(600, Math.round(u.prompt_tokens * 1.05));
    }
    const h = res && res.headers;
    if (!h || !h.get) return;
    const remaining = Number(h.get('x-ratelimit-remaining-tokens'));
    if (isFinite(remaining) && remaining < cloudEstimateIn) {
      const reset = Math.min(120, Math.max(cloudDurSec(h.get('x-ratelimit-reset-tokens')), 1));
      cloudFreeAt = Math.max(cloudFreeAt, Date.now() + reset * 1000);
    }
  } catch (_) {}
}

// последовательный слот к облаку + общий «свободен когда» для очереди
async function cloudSlot(job) {
  let release;
  const prev = cloudChain;
  cloudChain = new Promise((r) => {
    release = r;
  });
  await prev.catch(() => {});
  try {
    return await job();
  } finally {
    // следующий стартует не раньше этого момента: картинки гоним по одной,
    // иначе параллельные запросы только быстрее упираются в лимит токенов
    cloudFreeAt = Math.max(cloudFreeAt, Date.now() + 400);
    release();
  }
}

// Из простыни, которую отдаёт Groq на 429, оставляем только читаемое: поле
// error.message без хвоста про биллинг. Наивная обрезка по длине отрезала бы как
// раз «Please try again in Ns» — единственное полезное в этом ответе.
function cloudErrBrief(errText) {
  let s = String(errText || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  try {
    const j = JSON.parse(s);
    const m = j && j.error && (j.error.message || j.error.code);
    if (m) s = String(m).replace(/\s+/g, ' ').trim();
  } catch (_) { /* не JSON — показываем как есть */ }
  s = s.replace(/\s*(?:Need more tokens\?|Upgrade to|Please contact).*/i, '').trim();
  // Идентификатор аккаунта и тарифа — не диагностика, а данные владельца: в отчёт,
  // который потом пересылают в Telegram, им попадать незачем.
  s = s.replace(/\s+in organization\s+`?[^`\s]+`?/i, '').replace(/\s+service tier\s+`?[^`\s]+`?/i, '').trim();
  return s.length > 220 ? s.slice(0, 220) + '…' : s;
}

async function recognizeImageViaCloudApi(dataUrl, apiKey, vision, customPrompt, scene) {
  const cleanKey = (apiKey || '').trim();
  const isGroq = cleanKey.startsWith('gsk_');
  const endpoint = isGroq
    ? 'https://api.groq.com/openai/v1/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';

  // Для Groq: новейшие мультимодальные модели с аппаратным OCR
  // Для OpenAI: gpt-4o-mini с фолбэком на gpt-4o
  const models = isGroq
    ? ['qwen/qwen3.6-27b', 'qwen/qwen3.8-27b']
    : ['gpt-4o-mini', 'gpt-4o'];

  const prompt = cloudPromptFor(vision, customPrompt);

  // Один слот очереди на всю картинку: и ожидаем лимит, и пробуем модели внутри него
  return await cloudSlot(async () => {
    const startedAt = Date.now();
    const budgetLeft = () => Math.max(0, CLOUD_BUDGET_MS - (Date.now() - startedAt));
    const failRate = (err) => {
      const e = err || new Error('Лимит входных токенов облака');
      e.rateLimit = true;
      throw e;
    };

    // По заголовкам лимитов уже видно, что окно токенов не открылось, — ждём заранее,
    // не дёргая сервер заведомо проигрышным 429.
    const pre = cloudFreeAt - Date.now();
    if (pre > 0) {
      if (pre > budgetLeft()) failRate();
      await sleepMs(pre);
    }

    let lastError = null;
    // Внешний цикл — по моделям, внутренний — по попыткам той же модели. Оба
    // ограничены: «while (true)» без счётчика превращался в бесконечное долбление
    // облака при 400/404 или при сетевом сбое (fetch отваливался в catch той же
    // итерации и круг повторялся).
    for (const model of models) {
      for (let attempt = 0; attempt < CLOUD_RETRY_LIMIT; attempt++) {
        try {
          const payload = {
            model,
            messages: [
              {
                role: 'user',
                content: [
                  { type: 'text', text: prompt },
                  { type: 'image_url', image_url: { url: dataUrl } },
                ],
              },
            ],
            temperature: 0.1,
            max_completion_tokens: 1024,
          };

          if (isGroq) {
            payload.reasoning_format = 'hidden';
          }

          // Жёсткий таймаут на запрос: AbortController обрывает зависшее соединение.
          const vctrl = new AbortController();
          const vtimer = setTimeout(() => vctrl.abort(), CLOUD_REQ_MS);
          let res;
          try {
            res = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${cleanKey}`,
              },
              body: JSON.stringify(payload),
              signal: vctrl.signal,
            });
          } finally {
            clearTimeout(vtimer);
          }

          if (!res.ok) {
            const errText = await res.text().catch(() => '');
            // Цельная JSON-простыня на каждый из 16 кадров прогона ложится в консоль
            // мусором, в котором не найти настоящую строку; её же несёт в отчёт
            // анализатор через igxPaErrMsg. Заодно режем её до одного предложения.
            lastError = new Error(`Ошибка Cloud Vision (${model}, ${res.status}): ${cloudErrBrief(errText)}`);
            lastError.httpStatus = res.status;
            noteCloudUsage(res, null);
            // 401/403 — ключ не годится, вторая модель ничего не изменит: сигнализировать
            // локальной распознавалкой тут нельзя, пользователь должен увидеть правду.
            if (res.status === 401 || res.status === 403) {
              lastError.authError = true;
              throw lastError;
            }
            // 429 и 5xx — это не «модель сломалась»: та же модель через N секунд ответит
            // нормально, а «запасная» модель упрётся в те же лимиты того же аккаунта.
            if (res.status === 429 || res.status >= 500) {
              if (res.status === 429) lastError.rateLimit = true;
              const waitMs = cloudWaitSec(res, errText) * 1000;
              if (attempt + 1 < CLOUD_RETRY_LIMIT && waitMs <= budgetLeft()) {
                cloudFreeAt = Math.max(cloudFreeAt, Date.now() + waitMs);
                await sleepMs(waitMs);
                continue; // та же модель, просто окно лимита ещё не открылось
              }
              // бюджет ожидания вышел: при 429 честно сигналим о лимите (можно
              // дочитать локально), при 5xx — пробуем следующую модель
              if (lastError.rateLimit) failRate(lastError);
              break;
            }
            break; // 400/404 и прочие 4xx — вот здесь запасная модель уместна
          }

          const json = await res.json();
          noteCloudUsage(res, json);
          let text =
            (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || '';
          // Очищаем reasoning теги, если модель вернула их в raw виде
          text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

          // «Нет текста» — это пустой результат только в текстовом режиме: в режиме
          // vision под разделителем всё равно идёт описание картинки, его терять нельзя.
          if (!vision && /^\s*\(нет текста\)\s*$/i.test(text)) {
            return '';
          }
          return vision ? formatVisionAnswer(text, scene) : text.trim();
        } catch (err) {
          // негодный ключ и «бюджет ожидания лимита вышел» — наружу без retry:
          // оба сигнала нужны doOcr, чтобы решить, что делать дальше
          if (err && (err.authError || err.rateLimit)) throw err;
          lastError = err;
          // сетевой сбой/таймаут: остаётся бюджет попыток — короткая пауза и дальше
          if (attempt + 1 >= CLOUD_RETRY_LIMIT || !budgetLeft()) break;
          await sleepMs(400 * (attempt + 1));
        }
      }
    }

    if (lastError && lastError.rateLimit) failRate(lastError);
    throw lastError || new Error('Все модели Cloud Vision вернули ошибку.');
  });
}

// ---------- Локальная vision-модель (LM Studio / llama.cpp) ----------
// Облако на бесплатном Groq упирается в лимит токенов в минуту, а Tesseract не
// понимает стилизованный текст поверх видео. Своя модель на своём GPU закрывает обе
// беды: лимитов нет, кириллица читается. Стучимся в OpenAI-совместимый эндпоинт
// LM Studio (по умолчанию http://localhost:1234). НАСТРОЙКИ ЧИТАЕТ ЗДЕСЬ оффскрин,
// а не приходят полем от контента: тогда порядок «кто кого подменяет» физически не
// может разъехаться между двумя файлами у разных вызовов.
const LOCAL_OCR_ON_KEY = 'igx_local_ocr_on';
const LOCAL_OCR_URL_KEY = 'igx_local_ocr_url';
const LOCAL_OCR_MODEL_KEY = 'igx_local_ocr_model';
const LOCAL_OCR_ORDER_KEY = 'igx_local_ocr_order';
const LOCAL_OCR_DEFAULT_URL = 'http://localhost:1234';
const LOCAL_MAX_SIDE = 1280;   // больше — дольше префилл, а читаемость у модели не выше
const LOCAL_CONNECT_MS = 4000; // сервер выключен — узнаём сразу, а не через минуту
const LOCAL_REPLY_MS = 90000;  // первый кадр после простоя греется: префилл + генерация
const LOCAL_DEAD_MS = 60000;   // не ответил — не долбимся следующие N секунд
let localDeadUntil = 0;
let localModelCache = { base: '', id: '', at: 0 };

function localBase(url) {
  const raw = String(url || '').trim() || LOCAL_OCR_DEFAULT_URL;
  const withProto = /^https?:\/\//i.test(raw) ? raw : 'http://' + raw;
  return withProto.replace(/\/+$/, '');
}

// Снимок этих настроек, приехавший из content.js. Нужен ТОЛЬКО как подстраховка, когда
// до storage в этом документе достать не удалось, — владельцем настроек остаётся оффскрин.
let cfgSnapshot = null;
// Замечание «настройки не прочитались» — оно одно на прогон, а не на каждый кадр:
// повторяющаяся строка в отчёте 15 раз полезнее не делает.
let cfgWarnNote = '';
let cfgWarnSpilled = false;
function setCfgWarn(note) {
  if (note !== cfgWarnNote) {
    cfgWarnNote = note;
    cfgWarnSpilled = false;
  }
}

// Хозяин настроек — этот файл, но сама читка не имеет права ронять распознавание.
// Живой запуск дал «Cannot read properties of undefined (reading 'local')»: документ
// распознавания пережил перезагрузку расширения с сожжённым контекстом, и тогда падала
// не только тестовая кнопка, а ВЕСЬ OCR — `doOcrCore` читает настройки на каждом кадре.
// Пустой storage — это не «локалка выключена», а «мы не знаем, что настроено»: берём
// снимок со страницы, а если и его нет — живём по дефолтам и честно сообщаем причину
// наружу (cfg.error), чтобы отчёт не врал.
async function localCfgGet() {
  let d = null;
  let why = '';
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      d = await chrome.storage.local.get([LOCAL_OCR_ON_KEY, LOCAL_OCR_URL_KEY, LOCAL_OCR_MODEL_KEY, LOCAL_OCR_ORDER_KEY]);
    } else {
      why = 'хранилище настроек недоступно в этом документе';
    }
  } catch (e) {
    why = 'настройки не прочитались: ' + String((e && e.message) || e);
  }
  let src = '';
  if (!d) {
    if (cfgSnapshot && typeof cfgSnapshot === 'object') {
      d = cfgSnapshot;
      src = 'page';
    } else {
      d = {};
      src = 'default';
    }
  }
  const cfg = {
    on: d[LOCAL_OCR_ON_KEY] === true,
    base: localBase(d[LOCAL_OCR_URL_KEY]),
    model: String(d[LOCAL_OCR_MODEL_KEY] || '').trim(),
    // 'cloud' — облако хозяин, локалка подменой; 'local' — наоборот; 'only' — только локалка
    order: ['cloud', 'local', 'only'].indexOf(d[LOCAL_OCR_ORDER_KEY]) >= 0 ? d[LOCAL_OCR_ORDER_KEY] : 'cloud',
    // откуда фактически взялись значения: '' = из хранилища, 'page' = со страницы,
    // 'default' = ниоткуда (тогда on:false и полагаться на это нельзя)
    src: src,
    error: why,
  };
  noteCfgProblem(cfg);
  return cfg;
}

// Что делать, если читка не удалась: когда подставился снимок со страницы, пользователь
// получает ровно то, что сам и настроил, — потер нет и в отчёт лезть нечем. Когда не
// подставился ничего — локальный движок считается выключенным, и это надо сказать вслух:
// иначе режим «только локалка» молча превратился бы в облако.
function noteCfgProblem(cfg) {
  if (!cfg || !cfg.error) return setCfgWarn('');
  setCfgWarn(
    cfg.src === 'page'
      ? ''
      : '⚠ ' + cfg.error + ': настройки локальной модели не применены, кадр читали другие движки. Лечится перезагрузкой расширения и F5 на странице.'
  );
}

function fetchJson(url, opts, ms) {
  const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const to = setTimeout(() => {
    try {
      if (ac) ac.abort();
    } catch (_) {}
  }, ms);
  return fetch(url, ac && ac.signal ? Object.assign({}, opts, { signal: ac.signal }) : opts).finally(() => clearTimeout(to));
}

// LM Studio сам отдаёт загруженную модель, но поле `model` в теле обязано быть.
// Берём id из /v1/models и держим минуту, чтобы не опрашивать сервер на каждый кадр.
async function localModelId(cfg) {
  if (cfg.model) return cfg.model;
  if (localModelCache.base === cfg.base && localModelCache.id && Date.now() - localModelCache.at < 60000) {
    return localModelCache.id;
  }
  const r = await fetchJson(cfg.base + '/v1/models', { method: 'GET' }, LOCAL_CONNECT_MS);
  if (!r.ok) throw new Error('Локальная модель: /v1/models вернул ' + r.status);
  const j = await r.json().catch(() => null);
  const list = (j && j.data) || [];
  const ids = list
    .map((x) => String((x && (x.id || x.model)) || '').trim())
    .filter(Boolean);
  if (!ids.length) throw new Error('Локальная модель: в LM Studio сейчас нет загруженной модели');
  // `data[0]` — это НЕ «самая подходящая», а просто первая в списке: у пользователя
  // там рядом стоят и vision-модель, и текстовый 27B, и эмбеддинг. Картинка второму
  // не по зубам, и запрос вернётся ошибкой — ищем среди отданных id похожего на
  // мультимодальную, а не угадываем по порядку.
  const vision = ids.filter((id) => !/embedding|bge-|nomic/i.test(id));
  const pick =
    vision.find((id) => /vl|vision|multimodal|minicpm|moondream|llava|gemma.?3.?4n|pixtral|qwen.?omni/i.test(id)) ||
    vision[0] ||
    ids[0];
  localModelCache = { base: cfg.base, id: pick, at: Date.now() };
  return localModelCache.id;
}

async function recognizeViaLocalModel(imageSource, vision, customPrompt, scene, cfg) {
  const dataUrl = await imageSourceToDataUrl(imageSource, true, LOCAL_MAX_SIDE);
  const model = await localModelId(cfg);
  const res = await fetchJson(
    cfg.base + '/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: cloudPromptFor(vision, customPrompt) },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.1,
        // LM Studio понимает именно max_tokens (max_completion_tokens — опционально)
        max_tokens: 700,
      }),
    },
    LOCAL_REPLY_MS
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const e = new Error('Локальная модель ответила ' + res.status + (t ? ': ' + String(t).slice(0, 180) : ''));
    e.httpStatus = res.status;
    throw e;
  }
  const j = await res.json().catch(() => null);
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  let text = String((msg && (msg.content || msg.reasoning_content)) || '').replace(/<\/?think>[\s\S]*?<\/think>/gi, '').trim();
  // «Нет текста» — пустой результат только в текстовом режиме: в vision под
  // разделителем всё равно идёт описание кадра, терять его нельзя.
  if (!vision && /^\s*\(нет текста\)\s*$/i.test(text)) return '';
  return vision ? formatVisionAnswer(text, scene) : text;
}

// Вызов целиком с отделением «сервера нет» от «сервер есть, но не прочитал».
// Первое отправляет локалку в карантин: иначе 16 кадров по 4 с пингов = минута
// впустую на заведомо выключенном LM Studio.
async function localOcrCall(imageSource, vision, customPrompt, scene, cfg) {
  try {
    const text = await recognizeViaLocalModel(imageSource, vision, customPrompt, scene, cfg);
    localDeadUntil = 0;
    return { ok: true, text: (text || '').trim() };
  } catch (e) {
    if (!e || !e.httpStatus) localDeadUntil = Date.now() + LOCAL_DEAD_MS;
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Прогрев: одна крошечная картинка и 8 токенов ответа. У LM Studio первый запрос
// после простоя читает модель с диска (десятки секунд) — пусть эта плата видна
// отдельной строкой статуса ДО разбора, а не съест таймаут прямого видео OCR.
async function localWarmUp(cfg) {
  const t0 = Date.now();
  const cnv = document.createElement('canvas');
  cnv.width = 64;
  cnv.height = 64;
  const ctx = cnv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  const model = await localModelId(cfg);
  const res = await fetchJson(
    cfg.base + '/v1/chat/completions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [
          { type: 'text', text: 'Скажи одно слово: ок' },
          { type: 'image_url', image_url: { url: cnv.toDataURL('image/jpeg', 0.7) } },
        ] }],
        max_tokens: 8,
        temperature: 0,
      }),
    },
    180000
  );
  if (!res.ok) throw new Error('Локальная модель: прогрев вернул ' + res.status);
  localDeadUntil = 0;
  return { ms: Date.now() - t0, model };
}

// Простая оценка «человечности» распознанного текста. Нужна, чтобы выбирать лучший
// результат из нескольких проходов Tesseract, а не просто самый длинный: на стилизованном
// видео-тексте длинный результат часто оказывается мусором («вопли» вместо надписи).
function scoreOcrText(text) {
  const s = String(text || '').trim();
  if (!s) return 0;
  const tokens = s.split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;

  let good = 0;
  for (const t of tokens) {
    const letters = t.replace(/[^\p{L}\p{N}]/gu, '');
    if (letters.length < 2) continue;
    const vowels = (letters.match(/[аеёиоуыэюяaeiouy]/gi) || []).length;
    const consonants = letters.length - vowels;
    if (vowels === 0) continue;                 // слово без гласных — почти всегда мусор OCR
    if (consonants > vowels * 5) continue;      // перекос в согласные — тоже мусор
    good++;
  }
  const goodRatio = good / tokens.length;
  const lettersTotal = s.replace(/[^\p{L}]/gu, '').length;
  return goodRatio * 100 + Math.min(30, lettersTotal / 10);
}

// Лучший кандидат по оценке качества (при равенстве побеждает первый — PSM 3)
function pickBestOcrText(candidates) {
  let best = '';
  let bestScore = -1;
  for (const c of candidates) {
    const s = scoreOcrText(c);
    if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  }
  return best;
}

// Локальный OCR через Tesseract WASM на базе декодированного HTML Canvas.
// Вынесено из doOcr: этим путём пользуются и случай «ключа нет», и фолбэк
// «облако упёрлось в лимит токенов».
async function localOcr(imageSource) {
  const canvas = await imageSourceToCanvas(imageSource);
  const w = await getTWorker();

  // Кандидаты от разных проходов сегментации
  const candidates = [];
  const addCandidate = (t) => {
    const s = (t || '').trim();
    if (s) candidates.push(s);
  };

  // 1-й проход: авторазметка (PSM 3) по чистому сглаженному изображению
  let res = await w.recognize(canvas);
  const text3 = filterCleanTextLines(res && res.data);
  addCandidate(text3);

  // 2-й проход: если текста мало, пробуем режим единого блока (PSM 6)
  if (!text3 || text3.length < 10) {
    try {
      await w.setParameters({ tessedit_pageseg_mode: '6' });
      const res6 = await w.recognize(canvas);
      await w.setParameters({ tessedit_pageseg_mode: '3' });
      addCandidate(filterCleanTextLines(res6 && res6.data));
    } catch (_) {
      try {
        await w.setParameters({ tessedit_pageseg_mode: '3' });
      } catch (_) {}
    }
  }

  // 3-й проход: PSM 12 (разреженный текст) — для коротких надписей и стилизованных
  // заголовков на видео, где PSM 3/6 склеивают буквы в шум. Запускаем только если
  // лучший результат пока слабый. PSM 11 не используем: он требует OSD-данных (osd.traineddata).
  const bestBefore = pickBestOcrText(candidates);
  if (scoreOcrText(bestBefore) < 40) {
    try {
      await w.setParameters({ tessedit_pageseg_mode: '12' });
      const res12 = await w.recognize(canvas);
      addCandidate(filterCleanTextLines(res12 && res12.data));
    } catch (_) {
    } finally {
      try {
        await w.setParameters({ tessedit_pageseg_mode: '3' });
      } catch (_) {}
    }
  }

  // Выбираем не самый длинный, а самый «словоподобный» результат
  return pickBestOcrText(candidates);
}

// Замечание о непрочитанных настройках приносит ПЕРВЫЙ результат прогона, а не
// каждый кадр: x15 одинаковых строк в отчёте только мешают читать.
function spillCfgWarn(note) {
  if (!cfgWarnNote || cfgWarnSpilled) return note || '';
  cfgWarnSpilled = true;
  return note ? cfgWarnNote + '\n' + note : cfgWarnNote;
}

// Основной вход «одна картинка → текст». Возвращает { text, note }, чтобы тихий
// переезд на другой движок не выглядел для пользователя полноценным результатом
// нейронки. Порядок: облако → локальная модель (LM Studio) → Tesseract, но хозяина
// выбирает пользователь (`igx_local_ocr_order`), а не жёсткая прошивка.
//
// Одна картинка может оказаться не картинкой, а заглушкой (см. guard в
// `imageSourceToCanvas`): наружу это не ошибка разбора, а честный пустой результат
// с объяснением — иначе одно тёмное окно карусели обрывало бы прогон целиком.
async function doOcr(imageSource, apiKey, vision, customPrompt, scene) {
  try {
    // dataURL проходит в облако мимо декодера (быстрая ветка в `imageSourceToDataUrl`),
    // поэтому эту мелочь проверяем сами. Полноценный кадр стоит десятки килобайт
    // строки — второй раз его декодировать незачем, проверка отсекается по длине.
    if (typeof imageSource === 'string' && imageSource.startsWith('data:image/') && imageSource.length < 20000) {
      await imageSourceToCanvas(imageSource, { scaleUp: false });
    }
    const out = await doOcrCore(imageSource, apiKey, vision, customPrompt, scene);
    out.note = spillCfgWarn(out.note);
    return out;
  } catch (e) {
    if (e && e.tinyImage) {
      return { text: '', note: spillCfgWarn('⚠ ' + e.message + ': читать нечего, этот кадр пропущен.') };
    }
    throw e;
  }
}

// «Движок подменили» на каждый из кадров прогона — это полтора десятка одинаковых
// простыней в консоли, где на третьей пользователь перестаёт что-либо видеть. В
// отчёте заметка всё равно есть у каждого кадра, поэтому в консоль пускаем первую
// строку целиком, а дальше только счётчик.
const ocrWarnSeen = {};
function warnDedup(tag, msg) {
  const n = (ocrWarnSeen[tag] || 0) + 1;
  ocrWarnSeen[tag] = n;
  if (n === 1) console.warn(msg);
  else console.info(String(msg).slice(0, 90) + ' — ещё ' + (n - 1) + ' раз(а) за прогон');
}

async function doOcrCore(imageSource, apiKey, vision, customPrompt, scene) {
  const cleanKey = (apiKey || '').trim();
  const cloudOk = cleanKey.startsWith('gsk_') || cleanKey.startsWith('sk-');
  const cfg = await localCfgGet();
  const localUsable = cfg.on && Date.now() >= localDeadUntil;
  const localFirst = localUsable && (cfg.order === 'local' || cfg.order === 'only');
  const localNote = (why) => '⚠ Кадр прочитала локальная модель (LM Studio)' + (vision ? ', описание тоже от неё' : '') + ': ' + why + '.';

  // 1) локалка первой — когда она хозяин, и всегда, когда облачного ключа всё равно нет
  let localErr = '';
  if (localFirst || (localUsable && !cloudOk)) {
    const r = await localOcrCall(imageSource, vision, customPrompt, scene, cfg);
    // Хозяин прочитал — предупреждения не нужен: пользователь сам поставил локалку
    // на первое место, для него это штатный движок, а не замена.
    if (r.ok) return { text: r.text, note: '' };
    localErr = r.error;
    if (cfg.order === 'only') {
      // наружу не рвём: пользователь должен хотя бы получить то, что умеет Tesseract,
      // но честно узнать, что читала не нейросеть
      warnDedup('local-only', 'Локальная модель не смогла, дочитываем Tesseract: ' + localErr);
      const text = await localOcr(imageSource);
      return { text, note: '⚠ Локальная модель не смогла (' + localErr + ') — кадр дочитан Tesseract, текст может быть хуже обычного.' };
    }
  }

  // 2) облако
  if (cloudOk) {
    try {
      // forCloud=true: картинку не апскейлим (апскейл нужен только локальному
      // Tesseract, у нейронки он лишь раздувает число входных токенов), а режем до
      // CLOUD_MAX_SIDE
      const dataUrl = await imageSourceToDataUrl(imageSource, true);
      const cloudText = await recognizeImageViaCloudApi(dataUrl, cleanKey, !!vision, customPrompt, scene);
      return { text: (cloudText || '').trim(), note: '' };
    } catch (e) {
      // Негожий ключ показываем как есть: подмена локальной распознавалкой спрятала
      // бы настоящую причину, а пользователю нужно видеть, что чинить.
      if (e && e.authError) throw e;
      // Лимит токенов и сбои самого облака — временные: дочитаем кадр локально,
      // чтобы разбор профиля не падал целиком, и честно предупредим о качестве.
      if (!(e && (e.rateLimit || e.httpStatus >= 500))) throw e;
      if (localUsable && !localFirst) {
        const r = await localOcrCall(imageSource, vision, customPrompt, scene, cfg);
        if (r.ok) {
          return { text: r.text, note: localNote('облако упёрлось в лимит токенов или сбой') };
        }
        localErr = r.error;
      }
      warnDedup(
        'cloud-limited',
        'Cloud Vision не ответил (лимит токенов или сбой): ' + ((e && e.message) || e) +
          (localErr ? '; локальная модель: ' + localErr : '') + ' — кадр читает Tesseract'
      );
      const text = await localOcr(imageSource);
      return {
        text,
        note:
          '⚠ Облако упёрлось в лимит токенов в минуту' +
          (localErr ? ' и локальная модель не смогла (' + localErr + ')' : '') +
          ' — кадр прочитан локальной распознавалкой Tesseract' + (vision ? ', без описания картинки' : '') +
          '. Текст может быть хуже обычного.',
      };
    }
  }

  // 3) ни облака, ни удачной локалки: Tesseract, с объяснением если локалка пробовала
  if (localErr) {
    const text = await localOcr(imageSource);
    return { text, note: '⚠ Локальная модель не смогла (' + localErr + '), облачного ключа нет — читает Tesseract.' };
  }
  return { text: await localOcr(imageSource), note: '' };
}

function compactText(s) {
  const input = Array.isArray(s) ? s.join('\n') : String(s || '');
  const rawLines = input
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => {
      if (/^\d{1,2}:\d{2}\s*(?:\/|из|of)\s*\d{1,2}:\d{2}$/.test(l)) return false;
      if (l.length <= 1 && !/[\p{L}\p{N}]/u.test(l)) return false;
      return true;
    });

  const unique = [];
  const seen = new Set();
  for (const l of rawLines) {
    const key = l.toLowerCase().replace(/\s+/g, ' ');
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(l);
    }
  }

  // Удаляем строки, которые являются префиксами более длинных строк (артефакты анимации появления текста)
  // Метки vision-режима («Текст:», «Что в кадре:») — структура отчёта, их правило
  // «строка-префикс» трогать не должно.
  const STRUCT_RE = /^(?:текст|что\s+(?:на|в)\s+[\wа-яё]+)\s*[:—]/i;
  const finalLines = [];
  for (let i = 0; i < unique.length; i++) {
    const a = unique[i];
    const aNorm = a.toLowerCase().replace(/\s+/g, ' ');
    let isSub = false;
    if (!STRUCT_RE.test(aNorm)) {
      for (let j = 0; j < unique.length; j++) {
        if (i === j) continue;
        const bNorm = unique[j].toLowerCase().replace(/\s+/g, ' ');
        if (bNorm.length > aNorm.length && bNorm.includes(aNorm)) {
          isSub = true;
          break;
        }
      }
    }
    if (!isSub) {
      const validShort = new Set(['в', 'и', 'с', 'к', 'у', 'о', 'а', 'не', 'на', 'по', 'за', 'из', 'от', 'до', 'об']);
      if (aNorm.length <= 2 && !validShort.has(aNorm) && !/^\d+$/.test(aNorm)) {
        continue;
      }
      finalLines.push(a);
    }
  }

  return finalLines.join('\n');
}

// Распознавание изображения по прямому URL (для слайдов карусели).
// Возвращает тот же { text, note }, что и doOcr.
async function recognizeImageUrl(url, apiKey, vision, customPrompt) {
  return await doOcr(url, apiKey, vision, customPrompt, 'на слайде');
}

// Прямое извлечение кадров из видео по URL и распознавание текста
async function extractVideoFramesAndOcr(url, headTimestamps, tailTimestamps, apiKey, vision, customPrompt) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Не удалось загрузить видео (код ${resp.status})`);
  const arrayBuf = await resp.arrayBuffer();
  const blob = new Blob([arrayBuf], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);

  const video = document.createElement('video');
  const notes = []; // предупреждения OCR (переезд на локальную распознавалку)
  video.src = blobUrl;
  video.muted = true;
  video.playsInline = true;
  video.style.position = 'fixed';
  video.style.left = '-9999px';
  video.style.top = '-9999px';
  video.style.width = '640px';
  video.style.height = '360px';
  document.body.appendChild(video);

  try {
    await new Promise((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('Не удалось декодировать видео в фоновом документе.'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('Таймаут декодирования видео (20 с).'));
      }, 20000);
      function cleanup() {
        clearTimeout(timer);
        video.removeEventListener('loadeddata', onLoaded);
        video.removeEventListener('error', onError);
      }
      video.addEventListener('loadeddata', onLoaded);
      video.addEventListener('error', onError);
    });

    const w = video.videoWidth || 720;
    const h = video.videoHeight || 1280;
    const scale = Math.min(1.5, 1280 / Math.max(w, h));
    const cnv = document.createElement('canvas');
    cnv.width = Math.max(1, Math.round(w * scale));
    cnv.height = Math.max(1, Math.round(h * scale));
    const ctx = cnv.getContext('2d', { willReadFrequently: true });

    async function captureFrameAt(t) {
      return new Promise((resolve) => {
        let done = false;
        const fin = () => {
          if (done) return;
          done = true;
          video.removeEventListener('seeked', fin);
          clearTimeout(to);
          try {
            ctx.drawImage(video, 0, 0, cnv.width, cnv.height);
            resolve(cnv.toDataURL('image/jpeg', 0.92));
          } catch (e) {
            resolve(null);
          }
        };
        const to = setTimeout(fin, 1200);
        video.addEventListener('seeked', fin, { once: true });
        try {
          video.currentTime = Math.min(Math.max(0.01, (video.duration || 10) - 0.25), Math.max(0.01, t));
        } catch (_) {
          fin();
        }
      });
    }

    const headFrames = [];
    for (const t of headTimestamps) {
      const f = await captureFrameAt(t);
      if (f) headFrames.push(f);
    }

    const tailFrames = [];
    for (const t of tailTimestamps) {
      const f = await captureFrameAt(t);
      if (f) tailFrames.push(f);
    }

    const headTexts = [];
    for (let i = 0; i < headFrames.length; i++) {
      // Описание кадра просим ТОЛЬКО с первого кадра окна: кадров fps даёт много,
      // и гнать через платную нейронку каждый означало бы х10 расход за прогон.
      try {
        const r = await doOcr(headFrames[i], apiKey, i === 0 && !!vision, customPrompt, 'в кадре');
        if (r && r.text) headTexts.push(r.text);
        if (r && r.note) notes.push(r.note);
      } catch (e) {
        console.warn('Ошибка OCR кадра начала:', e);
      }
    }

    const tailTexts = [];
    for (let i = 0; i < tailFrames.length; i++) {
      try {
        const r = await doOcr(tailFrames[i], apiKey, i === 0 && !!vision, customPrompt, 'в кадре');
        if (r && r.text) tailTexts.push(r.text);
        if (r && r.note) notes.push(r.note);
      } catch (e) {
        console.warn('Ошибка OCR кадра конца:', e);
      }
    }

    return {
      headText: compactText(headTexts.join('\n')),
      tailText: compactText(tailTexts.join('\n')),
      note: notes.length ? notes[0] : '',
    };
  } finally {
    try {
      video.pause();
      video.src = '';
      video.remove();
    } catch (_) {}
    URL.revokeObjectURL(blobUrl);
  }
}

// ---------- ASR: речь из звука (Cloud API / Whisper Local) ----------
let asrPipe = null;

async function getAsrPipe() {
  if (asrPipe) return asrPipe;
  let transformers;
  try {
    transformers = await import(chrome.runtime.getURL('lib/transformers.min.js'));
  } catch (e) {
    throw new Error('Не удалось загрузить lib/transformers.min.js: ' + ((e && e.message) || e));
  }

  const env = transformers.env;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = true;

  if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
    env.backends.onnx.wasm.proxy = false;
    env.backends.onnx.wasm.numThreads = 1;
    env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('lib/');
  }

  const pipeline = transformers.pipeline;
  let firstErr = null;

  try {
    env.remoteHost = 'https://huggingface.co/';
    asrPipe = await pipeline('automatic-speech-recognition', 'onnx-community/whisper-tiny', {
      quantized: true,
    });
    return asrPipe;
  } catch (e1) {
    firstErr = e1;
    console.warn('Загрузка onnx-community/whisper-tiny с huggingface.co не удалась, пробуем Xenova/whisper-tiny:', e1);
  }

  try {
    env.remoteHost = 'https://huggingface.co/';
    asrPipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      quantized: true,
    });
    return asrPipe;
  } catch (e2) {
    console.warn('Загрузка Xenova/whisper-tiny с huggingface.co не удалась, пробуем через hf-mirror.com:', e2);
  }

  try {
    env.remoteHost = 'https://hf-mirror.com/';
    asrPipe = await pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny', {
      quantized: true,
    });
    return asrPipe;
  } catch (e3) {
    console.warn('Загрузка с hf-mirror.com не удалась:', e3);
    throw new Error(
      'Ошибка загрузки модели Whisper (проверь интернет или VPN): ' +
        ((firstErr && firstErr.message) || firstErr)
    );
  }
}

// Преобразование AudioBuffer в WAV Blob для отправки в Cloud API
function audioBufferToWav(buffer) {
  const numChannels = 1;
  const sampleRate = buffer.sampleRate;
  const channelData = buffer.getChannelData(0);
  const dataLen = channelData.length * 2;
  const bufferLen = 44 + dataLen;
  const out = new ArrayBuffer(bufferLen);
  const view = new DataView(out);

  function writeString(offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataLen, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * 2, true);
  view.setUint16(32, numChannels * 2, true);
  view.setUint16(34, 16, true); // 16 bit
  writeString(36, 'data');
  view.setUint32(40, dataLen, true);

  let offset = 44;
  for (let i = 0; i < channelData.length; i++) {
    const s = Math.max(-1, Math.min(1, channelData[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([out], { type: 'audio/wav' });
}

// Транскрибация через бесплатный Groq API (Whisper Large v3) или OpenAI API
async function transcribeViaCloudApi(audioBlobOrBytes, apiKey, prompt) {
  const cleanKey = (apiKey || '').trim();
  const isGroq = cleanKey.startsWith('gsk_');
  const endpoint = isGroq
    ? 'https://api.groq.com/openai/v1/audio/transcriptions'
    : 'https://api.openai.com/v1/audio/transcriptions';
  const model = isGroq ? 'whisper-large-v3' : 'whisper-1';

  const blob =
    audioBlobOrBytes instanceof Blob
      ? audioBlobOrBytes
      : new Blob([audioBlobOrBytes], { type: 'audio/webm' });

  const fd = new FormData();
  fd.append('file', blob, 'audio.webm');
  fd.append('model', model);
  fd.append('language', 'ru');
  fd.append('temperature', '0');
  if (prompt) fd.append('prompt', prompt);

  // Тот же жёсткий таймаут, что и у vision: зависшая транскрибация не должна вешать разбор.
  const actrl = new AbortController();
  const atimer = setTimeout(() => actrl.abort(), ASR_REQ_MS);
  let res;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cleanKey}`,
      },
      body: fd,
      signal: actrl.signal,
    });
  } finally {
    clearTimeout(atimer);
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ошибка ${isGroq ? 'Groq' : 'OpenAI'} API (${res.status}): ${errText}`);
  }

  const json = await res.json();
  return (json.text || '').trim();
}

// Очистка текста от галлюцинаций Whisper и повторяющихся слов/фраз при паузах или фоновой музыке
function cleanWhisperText(text) {
  if (!text) return '';
  let str = String(text).trim();

  str = str.replace(/субтитры\s+(?:делал|сделал|создал|подготовил|перевёл)[^\n\.\,]*/gi, '');
  str = str.replace(/спасибо\s+за\s+просмотр[^\n\.\,]*/gi, '');
  str = str.replace(/продолжение\s+следует[^\n\.\,]*/gi, '');
  str = str.replace(/редактор\s+субтитров[^\n\.\,]*/gi, '');

  const tokens = str.split(/(\s+)/);
  const out = [];
  let lastWord = '';
  let repeatCount = 0;

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^\s+$/.test(t)) {
      if (repeatCount === 0) out.push(t);
      continue;
    }
    const cleanWord = t.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    if (cleanWord && cleanWord === lastWord) {
      repeatCount++;
      continue;
    } else {
      lastWord = cleanWord;
      repeatCount = 0;
    }
    out.push(t);
  }

  let res = out.join('').trim();
  res = res.replace(/((?:[^\s]+\s+){1,4})\1{2,}/gi, '$1');
  return res.trim();
}

// Пересэмплирование аудиофрагмента в 16 кГц, пик-нормализация громкости и распознавание Whisper
async function transcribeSegment(audioBuffer, startSec, endSec, apiKey) {
  const start = Math.max(0, startSec);
  const end = Math.min(audioBuffer.duration, endSec);
  if (end <= start) return '';
  const dur = end - start;
  const targetLen = Math.max(1, Math.ceil(dur * 16000));
  const off = new OfflineAudioContext(1, targetLen, 16000);
  const src = off.createBufferSource();
  src.buffer = audioBuffer;
  src.connect(off.destination);
  src.start(0, start, dur);
  const rendered = await off.startRendering();
  const pcm = rendered.getChannelData(0);

  // Peak-нормализация
  let maxAmp = 0;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.abs(pcm[i]);
    if (v > maxAmp) maxAmp = v;
  }
  if (maxAmp < 0.005) {
    return '';
  }
  const gain = 0.95 / maxAmp;
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] *= gain;
  }

  // Если передан API ключ (Groq / OpenAI) — отправляем напрямую в Cloud API (мгновенно и без ошибок)
  const cleanKey = (apiKey || '').trim();
  if (cleanKey.startsWith('gsk_') || cleanKey.startsWith('sk-')) {
    try {
      const wavBlob = audioBufferToWav(rendered);
      return await transcribeViaCloudApi(wavBlob, cleanKey, RUSSIAN_ASR_PROMPT);
    } catch (e) {
      console.warn('Ошибка Cloud API в transcribeSegment, переключаемся на локальный Whisper:', e);
    }
  }

  // Локальный инференс через Transformers.js
  const pipe = await getAsrPipe();
  const res = await pipe(pcm, {
    language: 'russian',
    task: 'transcribe',
    return_timestamps: false,
    chunk_length_s: 30,
    stride_length_s: 5,
    max_new_tokens: 448,
    repetition_penalty: 1.1,
  });

  let raw = '';
  if (Array.isArray(res)) raw = res.map((r) => (r && r.text) || '').join(' ').trim();
  else raw = ((res && res.text) || '').trim();

  return cleanWhisperText(raw);
}

async function recognizeAudioBase64(base64, apiKey) {
  // Пустой/крошечный blob Groq режет 400 «file is empty» — и это же ломает локальный
  // декодер. Отсекаем до облака: ниже порога записывать было нечего (тишина/0 кадров).
  if (!base64 || typeof base64 !== 'string' || base64.length < 600) {
    throw new Error('Аудио пустое — записывать нечего.');
  }
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const cleanKey = (apiKey || '').trim();
  if (cleanKey.startsWith('gsk_') || cleanKey.startsWith('sk-')) {
    try {
      const blob = new Blob([bytes], { type: 'audio/webm' });
      return await transcribeViaCloudApi(blob, cleanKey, RUSSIAN_ASR_PROMPT);
    } catch (e) {
      console.warn('Ошибка Cloud API в recognizeAudioBase64, переключаемся на локальный декодер:', e);
    }
  }

  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  const decoded = await ac.decodeAudioData(bytes.buffer.slice(0));
  return transcribeSegment(decoded, 0, decoded.duration, apiKey);
}

async function recognizeAudioFromUrl(url, headTo, tailFrom, tailTo, apiKey) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Не удалось скачать видео (код ${resp.status}).`);
  const buf = await resp.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let decoded;
  try {
    decoded = await ac.decodeAudioData(buf);
  } catch (e) {
    throw new Error('Unable to decode audio data: видео-контейнер не поддерживается напрямую Web Audio API.');
  }
  if (!decoded || decoded.duration <= 0) throw new Error('В этом видео нет аудиодорожки.');

  const headText = await transcribeSegment(decoded, 0, headTo, apiKey);
  const tailText = await transcribeSegment(decoded, tailFrom, Math.min(decoded.duration, tailTo), apiKey);
  return { headText, tailText };
}

// ---------- Приём сообщений ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  // Снимок локальных настроек со страницы: пригодится только если до storage здесь
  // не достать. Сам владелец настроек — по-прежнему этот файл.
  if (msg.cfg && typeof msg.cfg === 'object') cfgSnapshot = msg.cfg;

  if (msg.type === 'ocrPing') {
    sendResponse({ ok: true });
    return true;
  }

  // Встроенные промпты наружу: редактор в попапе показывает их как шаблоны, чтобы
  // правку можно было начать с готового текста, а не с чистого листа. Держать их
  // копией в content.js было бы гарантированным расхождением двух файлов.
  if (msg.type === 'ocrPrompts') {
    sendResponse({ ok: true, text: OCR_TEXT_PROMPT, vision: OCR_VISION_PROMPT });
    return true;
  }

  // Проверка связи с локальной моделью (кнопка «Проверить» в OCR-попапе) и прогрев
  // перед прогоном: возвращаем id модели и время ответа, чтобы человек видел, живой
  // ли сервер и сколько стоит первая картинка, — ДО разбора, а не в его середине.
  if (msg.type === 'ocrLocalTest' || msg.type === 'ocrLocalWarm') {
    (async () => {
      try {
        const cfg = await localCfgGet();
        // Проверять нечего, если адрес мы не знаем: врать «выключено» при включённой
        // галке нельзя, поэтому говорим про настоящую причину.
        if (cfg.error && cfg.src !== 'page') {
          throw new Error(cfg.error + '. Лечится перезагрузкой расширения и F5 на странице Instagram.');
        }
        if (!cfg.on) throw new Error('Локальная модель выключена (галка «🏠 локальная модель» в настройках OCR)');
        if (msg.type === 'ocrLocalWarm') {
          const w = await localWarmUp(cfg);
          sendResponse({ ok: true, base: cfg.base, model: w.model, ms: w.ms, warm: true, via: cfg.src === 'page' ? 'настройки со страницы' : '' });
          return;
        }
        const t0 = Date.now();
        const id = await localModelId(cfg);
        localDeadUntil = 0;
        sendResponse({ ok: true, base: cfg.base, model: id, ms: Date.now() - t0, via: cfg.src === 'page' ? 'настройки со страницы' : '' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'ocrDo') {
    (async () => {
      try {
        const r = await doOcr(msg.image, msg.apiKey, !!msg.vision, msg.prompt, 'на картинке');
        sendResponse({ ok: true, text: r.text, note: r.note || '' });
      } catch (e) {
        tWorkerPromise = null;
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'ocrImageUrl') {
    (async () => {
      try {
        const r = await recognizeImageUrl(msg.url, msg.apiKey, !!msg.vision, msg.prompt);
        sendResponse({ ok: true, text: r.text, note: r.note || '' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'ocrVideoDo') {
    (async () => {
      try {
        const res = await extractVideoFramesAndOcr(
          msg.url,
          msg.headTimestamps || [],
          msg.tailTimestamps || [],
          msg.apiKey,
          !!msg.vision,
          msg.prompt
        );
        sendResponse({ ok: true, headText: res.headText, tailText: res.tailText, note: res.note || '' });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'asrDo') {
    (async () => {
      try {
        const text = await recognizeAudioBase64(msg.audio, msg.apiKey);
        sendResponse({ ok: true, text });
      } catch (e) {
        asrPipe = null;
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg.type === 'asrDoUrl') {
    (async () => {
      try {
        const res = await recognizeAudioFromUrl(msg.url, msg.headTo, msg.tailFrom, msg.tailTo, msg.apiKey);
        sendResponse({ ok: true, headText: res.headText, tailText: res.tailText });
      } catch (e) {
        asrPipe = null;
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  return false;
});
