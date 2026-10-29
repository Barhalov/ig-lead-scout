// qualify.js — квалификация лида: пол и «цвет строки» в Instagram.
// Общий файл: подключается к дашборду (<script src="qualify.js"> ДО dashboard.js)
// и к служебному воркеру (importScripts('qualify.js') ДО tg.js). Нужен именно общий:
// бот в /list фильтрует и сортирует базу по тем же признакам, что и сайт, — если
// алгоритм живёт в двух местах, они расходятся молча и незаметно.

// ----------DONE-флаги: какие списки эксперта уже прочеканы ----------
function normalizeDoneFlags(v) {
  if (!v || typeof v !== 'object') return { followers: false, following: false };
  const fol = !!(v.followers || v.followersAt);
  const fsg = !!(v.following || v.followingAt);
  // Легаси-формат {count, checkedAt} без типа списка — считаем как подписчики.
  if (!fol && !fsg && (v.count != null || v.checkedAt)) return { followers: true, following: false };
  return { followers: fol, following: fsg };
}

// Ключи storage, которые нужны квалификации (совпадают с константами дашборда).
const QUAL_MIN_KEY = 'igx_min_followers';
const QUAL_MAX_KEY = 'igx_max_followers';
const QUAL_DONE_PREFIX = 'igx_done:';
const QUAL_VIEWED_PREFIX = 'igx_viewed:';

// ---------- квалификация лида: пол и «цвет строки» в Instagram ----------
// Цвет повторяет ровно ту подсветку, которую рисует content.js в модалке списка
// (refreshRowStatus), но подписи на сайте — смысловые (что цвет показывает), а не
// «цвета радуги»: зелёный = «новый с ТГ», голубой = «просмотрено», синий = «неподходит»
// (на сайте он КРАСНЫЙ — так читается лучше; в инсте оставили как есть),
// пурпур/василёк/фиолет = «выжатость» (подписчики / подписки / оба списка).
const ACC_COLORS = {
  sent: { name: 'попал под авторазбор', hex: '#0a0a0c', hint: 'профиль уже разобран автоанализом со второго меню (есть штамп paAt или завершённый джоб)' },
  gold: { name: 'личка найдена', hex: '#ffd400', hint: 'доказанно живой Telegram (✅) либо deep-scan/авторазбор нашёл личку' },
  tgnew: { name: 'новый с ТГ', hex: '#3fd15e', hint: 'Telegram найден, проходит по фильтру сабов, профиль ещё не смотрели' },
  viewed: { name: 'просмотрено', hex: '#5b8dd6', hint: 'Telegram есть, но в этот профиль уже заходили' },
  nofit: { name: 'неподходит', hex: '#ef4444', hint: 'не проходит: нет Telegram / сабы вне фильтра / юз проверен и оказался не жив (канал, бот, мёртвый)' },
  fol: { name: 'выжаты подписчики', hex: '#a21caf', hint: 'список подписчиков уже прочекан' },
  fsg: { name: 'выжаты подписки', hex: '#2563eb', hint: 'список подписок уже прочекан' },
  both: { name: 'выжат полностью', hex: '#8b5cf6', hint: 'прочеканы оба списка — внутрь можно не лезть' },
  none: { name: 'не проверялся', hex: '#6b7280', hint: 'профиль ещё не проверялся' },
};
const ACC_COLOR_ORDER = ['sent', 'gold', 'tgnew', 'viewed', 'nofit', 'fol', 'fsg', 'both', 'none'];

// ---------- «реальность» TG: одно место, где состояние становится словом ----------
// Канал, которым доказывается «реальность». Один список на три мира: значение читает
// воркер (что проверять), дашборд (запускать ли прогон и как подписать цифру) и болт
// в инсте. Объявить дважды нельзя — qualify.js и tg.js исполняются в одном realm воркера.
const TG_VERIFY_MODES = ['tme', 'webtg', 'off'];
const TG_VERIFY_MODE_KEY = 'igx_tg_verify_mode'; // 'tme' (дефолт) | 'webtg' | 'off'

// Пишет вердикт только воркер (tg.js: tgWriteReal). Здесь его ТОЛЬКО читаем и называем,
// чтобы болт в инсте, плашка на дашборде и строка в боте говорили одними словами: расхождение
// таких мест незаметно — «✅ ТГ» на экране означает «проверено», только если проверка была.
// Четыре состояния, а не два: «не проверялся» обязан отличаться от «мёртв», иначе отсутствие
// работы (жёлтый ноль на 5k профилей) читается как результат работы.
function tgRealStateOf(p) {
  const rec = p || {};
  const st = {
    state: rec.telegram ? 'unchecked' : 'none',
    icon: rec.telegram ? '❔' : '',
    label: rec.telegram ? 'не проверялся' : 'TG не найден',
    why: '',
    via: rec.tgRealVia || '',
    at: Number(rec.tgRealAt) || 0,
  };
  if (!rec.telegram) return st;
  if (rec.tgReal === true) {
    st.state = 'verified'; st.icon = '✅'; st.label = 'жив'; st.why = '';
  } else if (rec.tgReal === false) {
    st.state = 'dead'; st.icon = '✖'; st.label = 'не жив';
    st.why = String(rec.tgRealWhy || 'ссылка проверена — живой лички нет');
  } else if (rec.tgReal === 'unknown') {
    st.state = 'unknown'; st.icon = '❔'; st.label = 'не удалось проверить';
    st.why = String(rec.tgRealWhy || 'сеть/лимит t.me');
  } else if (rec.tgExists === false) {
    // Легаси: до слоя доказательности «не подтверждён» писали только в tgExists.
    // Это тоже решительный вердикт (его выводил проверка, а не отсутствие данных).
    st.state = 'dead'; st.icon = '✖'; st.label = 'не жив';
    st.why = String(rec.tgRealWhy || 'юз не подтверждён проверкой');
  }
  return st;
}

function accColorOf(p, ctx) {
  ctx = ctx || {};
  // «Попал под авторазбор» (чёрный) — самый верх: профиль уже прогнан автоанализом
  // со второго меню. Это финальная судьба лида, перекрывает остальное (по выбору юзера).
  if (ctx.analyzed) return 'sent';
  // «Личка найдена» (золото) = ровно то же, что плашка ✅ в уведомлениях/истории:
  //   • TG проверен и доказан живым (tgReal === true) — главный смысл «нашёл личку»;
  //   • ручной глубокий скан контактов нашёл личку внутри (tgContacts);
  //   • разбор на втором меню нашёл и отправил личку (aaFound).
  // Стоит ДО гейта «не проверялся» и ДО фильтра по сабам: найденная личка — результат
  // работы, она не должна теряться из-за отсутствия checkedAt/просмотра или незабора сабов.
  const lichkaFound = p.tgReal === true
    || (Array.isArray(p.tgContacts) && p.tgContacts.length) || ctx.aaFound;
  if (lichkaFound) return 'gold';
  if (!p.checkedAt && !ctx.viewed) return 'none';
  const ds = ctx.ds;
  if (ds.followers || ds.following) return ds.followers && ds.following ? 'both' : ds.followers ? 'fol' : 'fsg';
  const hasTg = !!p.telegram;
  const meets = (ctx.minF <= 0 || (p.followers != null && p.followers >= ctx.minF)) &&
    (ctx.maxF <= 0 || p.followers == null || p.followers <= ctx.maxF);
  // «зелёный = есть TG» больше не про наличие СТРОКИ: если ревизия доказала, что юза
  // нет (или это канал/бот), строка не имеет права выглядеть лидом — она в «неподходит»
  // с причиной. Не проверявшийся профиль при этом остаётся зелёным: это не «мёртв».
  if (p.tgReal === false) return 'nofit';
  if (hasTg && meets && p.tgExists !== false) return ctx.viewed ? 'viewed' : 'tgnew';
  return 'nofit';
}

// ---- Пол профиля: база имён + родовые окончания ----
// Instagram пол не отдаёт. Раньше искали слова «женщин*», «девушк*» и т.п. — а это
// маркеры АУДИТОРИИ: «тренер девушек» записывался в женщины. Теперь считаем только
// личные признаки и складываем их с весом:
//   1) имя из базы имён: в fullName оно решает исход (человек сам так подписал профиль),
//      в bio/нике — только довод с небольшим весом;
//   2) кто о себе: «мама/папа», «мужчина/женщина», she/her, ♀/♂;
//   3) глаголы и краткие формы прошедшего от первого лица: «похудела/сделала» — она,
//      «похудел/сделал» — он; то же по окончанию (-ла/-лась против -лся/-л) для слов
//      вне словаря;
//   4) местоимения «она»/«он».
// Слова про аудиторию («женский клуб», «для мужчин», «девушек») в расчёт не идут.
// Ничьих маркеров или равный счёт → пол «не определён», не гадаем.
// Ё приводится к е, поэтому в списках достаточно одной формы.
const G_NAMES_F = ['анна', 'мария', 'марья', 'маргарита', 'рита', 'елена', 'ольга', 'олька', 'оля',
  'наталья', 'наталия', 'наташа', 'екатерина', 'катерина', 'катя', 'анастасия', 'настя', 'юлия', 'юля',
  'виктория', 'вика', 'дарья', 'дария', 'даша', 'алина', 'лина', 'карина', 'каролина', 'полина', 'злата',
  'ирина', 'ира', 'светлана', 'света', 'софия', 'софья', 'арина', 'кристина', 'христина', 'инна',
  'оксана', 'ксения', 'татьяна', 'таня', 'марина', 'елизавета', 'лиза', 'маша', 'вероника',
  'лариса', 'галина', 'валентина', 'валерия', 'людмила', 'люда', 'нина', 'лидия', 'тамара', 'яна',
  'диана', 'элина', 'амелия', 'алиса', 'милана', 'камила', 'амира', 'замира', 'рамиля', 'гульнара',
  'лейла', 'айгуль', 'алсу', 'эльвира', 'рената', 'офелия', 'стелла', 'нинель', 'розалия',
  'анжела', 'анжелика', 'вита', 'кира', 'элла', 'ева', 'гузель', 'мадина', 'камилла',
  'милена', 'ярослава', 'азиза', 'лавиния', 'беатрис', 'зульфия', 'алия', 'самира', 'инара',
  'эмилия', 'милослава'];
const G_NAMES_M = ['александр', 'шура', 'сергей', 'сережа', 'андрей', 'дима', 'дмитрий', 'максим',
  'владимир', 'влад', 'алексей', 'алеша', 'игорь', 'кирилл', 'михаил', 'миша', 'никита', 'роман',
  'егор', 'павел', 'паша', 'данил', 'даниил', 'тимофей', 'тимур', 'матвей', 'иван', 'ваня', 'степан',
  'владислав', 'вячеслав', 'станислав', 'богдан', 'георгий', 'ефим', 'савва', 'марк', 'антон',
  'федор', 'виктор', 'леонид', 'геннадий', 'николай', 'коля', 'валерий', 'олег', 'юрий', 'григорий',
  'артем', 'артур', 'руслан', 'рустам', 'рамис', 'марат', 'ильдар', 'ильяс', 'дамир', 'камиль',
  'талят', 'ренат', 'равиль', 'эдуард', 'борис', 'константин', 'ярослав', 'евгений',
  'денис', 'слават', 'заур', 'аскер', 'разиль', 'саян', 'амир', 'аслан', 'азамат', 'муслим',
  'платон', 'лука', 'гордей', 'мирон', 'тихон', 'семен', 'захар',
  'феликс', 'герман', 'аркадий', 'игнат', 'кузьма', 'макар', 'савелий', 'емельян', 'петр',
  'святослав', 'прохор'];
// Глагольные и краткие пары — собраны строго парами (f, m), чтобы ни одна сторона не
// выигрывала только из-за полноты списка.
const G_PRED_PAIRS = [
  ['была', 'был'], ['стала', 'стал'], ['могла', 'мог'], ['хотела', 'хотел'], ['знала', 'знал'],
  ['любила', 'любил'], ['делала', 'делал'], ['сделала', 'сделал'], ['писала', 'писал'],
  ['думала', 'думал'], ['жила', 'жил'], ['мечтала', 'мечтал'], ['шла', 'шел'], ['брала', 'брал'],
  ['взяла', 'взял'], ['дала', 'дал'], ['создала', 'создал'], ['начала', 'начал'],
  ['закончила', 'закончил'], ['окончила', 'окончил'], ['работала', 'работал'],
  ['училась', 'учился'], ['отучилась', 'отучился'], ['добилась', 'добился'],
  ['изменилась', 'изменился'], ['записалась', 'записался'], ['похудела', 'похудел'],
  ['сбросила', 'сбросил'], ['набрала', 'набрал'], ['открыла', 'открыл'], ['закрыла', 'закрыл'],
  ['продала', 'продал'], ['купила', 'купил'], ['готовила', 'готовил'], ['тренировала', 'тренировал'],
  ['решила', 'решил'], ['смогла', 'смог'], ['увидела', 'увидел'], ['пришла', 'пришел'],
  ['вышла', 'вышел'], ['осталась', 'остался'], ['родилась', 'родился'], ['выиграла', 'выиграл'],
  ['проиграла', 'проиграл'], ['заработала', 'заработал'], ['запустила', 'запустил'],
  ['написала', 'написал'], ['сказала', 'сказал'], ['поняла', 'понял'], ['почувствовала', 'почувствовал'],
  ['переехала', 'переехал'], ['вернулась', 'вернулся'], ['справилась', 'справился'],
  ['боролась', 'боролся'], ['старалась', 'старался'], ['выступала', 'выступал'],
  ['рада', 'рад'], ['готова', 'готов'], ['должна', 'должен'], ['уверена', 'уверен'],
  ['убеждена', 'убежден'], ['довольна', 'доволен'], ['влюблена', 'влюблен'], ['счастлива', 'счастлив'],
  ['занята', 'занят'], ['увлечена', 'увлечен'], ['мотивирована', 'мотивирован'],
  ['вдохновлена', 'вдохновлен'], ['заинтересована', 'заинтересован'], ['обрадована', 'обрадован'],
  ['удовлетворена', 'удовлетворен'], ['нацелена', 'нацелен'], ['замужем', 'женат'],
];
const G_SELF_F = ['мама', 'мамочка', 'мамуля', 'мать', 'женшина', 'женщина', 'девушка', 'леди',
  'дама', 'дамочка', 'красавица', 'девочка', 'дочь', 'дочка', 'дочурка', 'сестра', 'жена', 'невеста',
  'бабушка', 'внучка', 'королева', 'принцесса', 'барышня', 'хозяйка', 'госпожа'];
const G_SELF_M = ['папа', 'папочка', 'папуля', 'отец', 'батя', 'мужчина', 'мужик', 'парень', 'юноша',
  'муж', 'жених', 'сын', 'сынок', 'брат', 'дедушка', 'внук', 'король', 'принц', 'хозяин', 'господин',
  'бизнесмен'];
// В английском падежей нет, поэтому «woman/women/lady/girl» — то же самое, что «девушек»:
// аудитория («I help women lose weight»). В расчёт идут только личные местоимения,
// семейные роли и обращения к себе.
const G_EN_F = ['she', 'her', 'hers', 'mom', 'mum', 'mother', 'daughter', 'sister', 'wife',
  'miss', 'mrs', 'madam', 'princess', 'queen'];
const G_EN_M = ['he', 'him', 'his', 'dad', 'father', 'son', 'brother', 'husband', 'sir', 'mr',
  'mister', 'gentleman', 'king', 'prince'];
// Слова на -л, которые глаголами прошедшего времени не являются (иначе «люблю футбол»
// сделало бы из человека мужчину).
const G_END_M_STOP = new Set(['финал', 'оригинал', 'сигнал', 'журнал', 'канал', 'подвал', 'вокзал',
  'карнавал', 'ритуал', 'пьедестал', 'провал', 'интервал', 'квартал', 'скандал', 'генерал', 'маршал',
  'капитал', 'минерал', 'овал', 'пенал', 'факел', 'прицел', 'предел', 'винодел', 'стол', 'стул',
  'угол', 'укол', 'купол', 'футбол', 'баскетбол', 'волейбол', 'гандбол', 'пол', 'дол', 'нал', 'бал',
  'зал']);
// Имена не глаголы: «Павел» формально оканчивается на -ел, но это не «он сделал».
// Для окончаний имена (и слова из стоп-листа) — запрет.
const G_ALL_NAMES = new Set(G_NAMES_F.concat(G_NAMES_M));
const G_SKIP_END_M = new Set([].concat([...G_ALL_NAMES], [...G_END_M_STOP]));

// ---- Латиница: имена в юзах/никах (elena32, Serjy, Nekit) и в TG-хэндлах ----
// Русскоязычный Instagram массово пишет имя латиницей в ник, причём в любой
// транслитерации (Sergey / Serjy / Serezha…). Кириллический G_NAMES такое не ловит:
// пол «не виден», а случайный ♀ или женское слово в bio записывало мужика в женщины.
// Держим отдельные латинские базы и матчим ПО ТОКЕНАМ (разбиваем по не-буквам и
// границам регистра, отбрасываем цифры): «elena32»→elena, «serjy2007»→serjy, но
// «elenakiss»→elenakiss (не имя, не трогаем) — без ложных срабатываний на подстроках.
// Коротких омонимов-слов (will/bill/max/mark/sam/dan/tom/ken/ray) в списках нет.
const G_LAT_F = [
  'elena', 'alena', 'elen', 'lena', 'olena', 'helena', 'olga', 'olka', 'olya', 'anna', 'ann', 'anya',
  'maria', 'mariya', 'maryia', 'mariana', 'marika', 'marusya', 'masha', 'daria', 'dariya', 'darina',
  'natalia', 'natalya', 'nathalia', 'nata', 'natasha', 'natakha', 'ekaterina', 'katerina', 'catherine', 'kate', 'katya', 'katia', 'katusha',
  'anastasia', 'nastya', 'nasta', 'yuliya', 'yulia', 'juliya', 'julia', 'juliana', 'yulya', 'victoria', 'viktoriya', 'vika',
  'darya', 'aliya', 'alina', 'karina', 'carina', 'karyna', 'polina', 'zlata', 'irina', 'svetlana', 'sveta', 'sofia', 'sofya', 'sophia', 'sonia', 'sonya',
  'arina', 'kristina', 'christina', 'inna', 'oksana', 'oxana', 'ksenia', 'xenia', 'ksusha', 'tatyana', 'tatiana', 'tanya', 'tania',
  'marina', 'elizaveta', 'elisaveta', 'liza', 'veronika', 'veronica', 'vera', 'larisa', 'galina', 'galya', 'valentina', 'valya', 'valeria', 'valeriya',
  'lyudmila', 'lyuda', 'nina', 'lidia', 'lidiya', 'tamara', 'yana', 'diana', 'elina', 'amelia', 'ameliya', 'alisa', 'lisa', 'milana', 'kamila', 'camila',
  'amira', 'elmira', 'elvira', 'renata', 'ofelia', 'ofeliya', 'stella', 'ninel', 'rozaliya', 'roza', 'angela', 'angelica', 'vita', 'kira', 'ella', 'eva',
  'guzel', 'guzelya', 'madina', 'milena', 'yaroslava', 'aziza', 'zulfiya', 'samira', 'amina', 'emiliya', 'miloslava',
  'emily', 'emma', 'olivia', 'isabella', 'bella', 'charlotte', 'abigail', 'hannah', 'lucy', 'lily', 'zoe', 'chloe', 'ruby', 'daisy', 'poppy', 'ellie',
  'madison', 'scarlett', 'sarah', 'sara', 'laura', 'claire', 'mary', 'martha', 'nicole', 'michelle', 'jessica', 'jennifer', 'jenny', 'amanda', 'ashley',
  'christine', 'deborah', 'diane', 'elizabeth', 'margaret', 'patricia', 'rachel', 'rebecca', 'samantha', 'sandra', 'stephanie', 'tiffany', 'vivian', 'wendy', 'yolanda',
];
const G_LAT_M = [
  'aleksandr', 'alexander', 'alexandr', 'alexsandr', 'sasha', 'shura', 'sergey', 'sergei', 'sergej', 'sergi', 'serge', 'serzh', 'serj', 'serjy', 'serezha', 'serega', 'srgey', 'serguei',
  'andrey', 'andrei', 'andrij', 'andrew', 'andy', 'dmitry', 'dmitri', 'dimitry', 'dmitriy', 'maxim', 'maksim', 'vladimir', 'vlad', 'vova', 'volodya',
  'alexey', 'aleksey', 'alexei', 'aleksei', 'lesha', 'igor', 'kirill', 'mikhail', 'misha', 'nikita', 'nikit', 'nekit', 'niket', 'nekita', 'roman', 'roma', 'egor', 'pavel', 'pasha',
  'danil', 'daniil', 'daniel', 'timofey', 'timur', 'matvey', 'matvei', 'ivan', 'vanya', 'stepan', 'vladislav', 'slava', 'vyacheslav', 'stanislav', 'stas', 'bogdan',
  'georgy', 'george', 'efim', 'savva', 'anton', 'fedor', 'viktor', 'victor', 'leonid', 'nikolay', 'nikolai', 'nicholas', 'kolya', 'valery', 'valera', 'oleg',
  'yuri', 'yura', 'grigory', 'grisha', 'artem', 'artemiy', 'artur', 'arthur', 'ruslan', 'rustam', 'ramis', 'marat', 'ildar', 'ilyas', 'damir', 'kamil', 'talat', 'renat', 'eduard', 'edward',
  'boris', 'konstantin', 'kostya', 'yaroslav', 'evgeny', 'evgeniy', 'zhenya', 'denis', 'amir', 'aslan', 'azamat', 'platon', 'luka', 'miron', 'semen', 'simon', 'zakhar', 'felix', 'german',
  'arkadiy', 'ignat', 'makar', 'petr', 'pyotr', 'peter', 'petya', 'svyatoslav', 'prohor', 'lev',
  'james', 'david', 'john', 'jack', 'robert', 'michael', 'william', 'richard', 'joseph', 'charles', 'thomas', 'anthony', 'donald', 'steven', 'paul', 'jeffrey', 'gregory', 'jerry', 'henry', 'douglas', 'lawrence', 'frederick', 'albert', 'brandon', 'bradley', 'austin', 'justin', 'nathan', 'jonathan', 'joshua', 'dominic', 'sebastian', 'theodore', 'nicolas', 'gabriel', 'rafael',
];
const G_LAT_F_SET = new Set(G_LAT_F);
const G_LAT_M_SET = new Set(G_LAT_M);
// Токены имени из произвольной строки: границы регистра (ElenaPetrova→elena,petrova)
// + разделители-не-буквы; минимум 3 буквы отсекает шум («aa», «li», «iv»).
function nameTokens(s) {
  return String(s || '').replace(/([a-z\d])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3);
}
function latNameHits(s, set) {
  const out = [];
  for (const t of nameTokens(s)) if (set.has(t) && !out.includes(t)) out.push(t);
  return out;
}
// Хэндлы Telegram: юзернейм из ссылки t.me и найденные лички (tgContacts).
function tgHandleStrings(p) {
  const out = [];
  const raw = String((p && p.telegram) || '');
  const m = raw.match(/t\.me\/([^/?#\s]+)/i);
  if (m) out.push(m[1]);
  else if (raw && !/^https?:/i.test(raw)) out.push(raw.replace(/^@/, ''));
  if (p && Array.isArray(p.tgContacts)) for (const c of p.tgContacts) out.push(String(c).replace(/^@/, ''));
  return out.filter(Boolean);
}
// Фамильные родовые окончания в латинице: Ivanov / Petrov — он, Ivanova / Petrova — она.
// Очень частый и надёжный маркер у русскоязычных, у которых в юзе только фамилия.
// Берём суффиксы, малопопулярные в английских словах (-ov/-ev/-skiy против -ova/-eva/-skaya),
// и токен не короче 5 букв; сами имена не считаем фамилией.
function latSurnameGender(s) {
  const f = [], m = [];
  for (const t of nameTokens(s)) {
    if (t.length < 5 || G_LAT_F_SET.has(t) || G_LAT_M_SET.has(t)) continue;
    if (/(?:ova|eva|skaya)$/.test(t)) f.push(t);
    else if (/(?:ov|ev|skiy)$/.test(t)) m.push(t);
  }
  return { f, m };
}

function gRe(list) {
  return new RegExp('(?:^|[^\\p{L}])(' + list.join('|') + ')(?=$|[^\\p{L}])', 'giu');
}
function gWords(re, text, limit, skip) {
  const out = [];
  if (!re || !text) return out;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text))) {
    const t = String(m[1] || '');
    if (t && (!skip || !skip.has(t)) && !out.includes(t)) out.push(t);
    if (out.length >= (limit || 4)) break;
    if (re.lastIndex >= text.length) break;
  }
  return out;
}
const G_RE = {
  nameF: gRe(G_NAMES_F), nameM: gRe(G_NAMES_M),
  selfF: gRe(G_SELF_F), selfM: gRe(G_SELF_M),
  verbF: gRe(G_PRED_PAIRS.map((p) => p[0])), verbM: gRe(G_PRED_PAIRS.map((p) => p[1])),
  enF: gRe(G_EN_F), enM: gRe(G_EN_M),
  // «…ла/…лась» — она; «…лся/…л» — он. Стему нужно ≥2 буквы: «был/жил/дал» закроет словарь.
  endF: /(?:^|[^\p{L}])(\p{L}{2,}(?:а|я|е|и|о|у)(?:лась|ла))(?:$|[^\p{L}])/giu,
  endM: /(?:^|[^\p{L}])(\p{L}{2,}(?:а|я|е|и|о|у)(?:лся|л))(?:$|[^\p{L}])/giu,
  proF: gRe(['она']), proM: gRe(['он']),
};
// Возвращает { g:'f'|'m'|'', f, m, why:{f:[],m:[]} } — why пригодится в подсказке бейджа.
function detectGender(p) {
  const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
  // Отображаемое имя Telegram (tgName) — личный признак уровня fullName: человек сам
  // так подписался, поэтому оно РЕШАЕТ так же, как имя в IG. Bio из TG-карточки (tgBio)
  // — только довοд, как и IG-bio: там случаются и ♀, и слова про аудиторию.
  const name = [norm(p.fullName), norm(p.tgName)].filter(Boolean).join(' \u00b7 ');
  const bio = [norm(p.bio), norm(p.tgBio)].filter(Boolean).join('\n');
  const nick = norm(p.username);
  const hay = [name, bio].filter(Boolean).join('\n');
  const res = { g: '', f: 0, m: 0, why: { f: [], m: [] } };
  if (!hay && !nick) return res;
  const hit = (side, w, label, token) => {
    res[side] += w;
    const pretty = token.charAt(0).toUpperCase() + token.slice(1); // текст ниже регистра, а в подсказке приятнее с большой
    const s = label + ' «' + pretty + '»';
    if (res.why[side].length < 8 && !res.why[side].includes(s)) res.why[side].push(s);
  };
  const scan = (side, w, label, re, text, limit, skip) => {
    gWords(re, text, limit, skip).forEach((t) => hit(side, w, label, t));
  };
  // Имя в fullName — решается сразу: человек сам так подписал профиль, и никакие
  // «похудела/сделала» в отзывах о клиентах этого не перебивают.
  const tgHandles = tgHandleStrings(p).map(norm);
  const nickPool = [nick].concat(tgHandles).filter(Boolean);
  // Имя в fullName — решается сразу: человек сам так подписал профиль, и никакие
  // «похудела/сделала» в отзывах о клиентах этого не перебивают. Берём и кириллицу,
  // и латиницу (имя по-английски или транслитом прямо в имени).
  const nameF = gWords(G_RE.nameF, name, 2).concat(latNameHits(name, G_LAT_F_SET));
  const nameM = gWords(G_RE.nameM, name, 2).concat(latNameHits(name, G_LAT_M_SET));
  let decisive = '';
  if (nameF.length && !nameM.length) decisive = 'f';
  if (nameM.length && !nameF.length) decisive = 'm';
  nameF.forEach((t) => hit('f', 6, 'имя', t));
  nameM.forEach((t) => hit('m', 6, 'имя', t));
  scan('f', 3, 'имя в описании', G_RE.nameF, bio, 1);
  scan('m', 3, 'имя в описании', G_RE.nameM, bio, 1);
  // Имя в НИКе и в TG-хэндле — сильный личный маркер (человек сам так назвал адрес),
  // вес как у имени. Если в fullName имени нет — ник РЕШАЕТ: иначе Serjy/Nekit со
  // случайным ♀ или «похудела» в описании записывались в женщины.
  const nickF = [], nickM = [];
  for (const s of nickPool) {
    gWords(G_RE.nameF, s, 2).forEach((t) => { if (!nickF.includes(t)) nickF.push(t); });
    gWords(G_RE.nameM, s, 2).forEach((t) => { if (!nickM.includes(t)) nickM.push(t); });
    latNameHits(s, G_LAT_F_SET).forEach((t) => { if (!nickF.includes(t)) nickF.push(t); });
    latNameHits(s, G_LAT_M_SET).forEach((t) => { if (!nickM.includes(t)) nickM.push(t); });
  }
  nickF.forEach((t) => hit('f', 6, 'имя в нике/TG', t));
  nickM.forEach((t) => hit('m', 6, 'имя в нике/TG', t));
  if (!decisive) {
    if (nickF.length && !nickM.length) decisive = 'f';
    else if (nickM.length && !nickF.length) decisive = 'm';
  }
  // Фамильные окончания (не решают сами по себе, но перевеивают случайный ♀/женское слово).
  const snFull = latSurnameGender(name);
  snFull.f.forEach((t) => hit('f', 4, 'фамилия', t));
  snFull.m.forEach((t) => hit('m', 4, 'фамилия', t));
  for (const s of nickPool) {
    const sn = latSurnameGender(s);
    sn.f.forEach((t) => hit('f', 4, 'фамилия в нике/TG', t));
    sn.m.forEach((t) => hit('m', 4, 'фамилия в нике/TG', t));
  }
  scan('f', 4, 'о себе', G_RE.selfF, hay, 3);
  scan('m', 4, 'о себе', G_RE.selfM, hay, 3);
  scan('f', 4, 'сказала о себе', G_RE.verbF, hay, 3);
  scan('m', 4, 'сказал о себе', G_RE.verbM, hay, 3);
  scan('f', 3, 'англ.', G_RE.enF, hay, 2);
  scan('m', 3, 'англ.', G_RE.enM, hay, 2);
  scan('f', 2, 'окончание', G_RE.endF, hay, 3, G_ALL_NAMES);
  scan('m', 2, 'окончание', G_RE.endM, hay, 3, G_SKIP_END_M);
  scan('f', 2, 'местоимение', G_RE.proF, hay, 1);
  scan('m', 2, 'местоимение', G_RE.proM, hay, 1);
  if (/♀/.test(hay)) hit('f', 3, 'символ', '♀');
  if (/♂/.test(hay)) hit('m', 3, 'символ', '♂');
  if (decisive) { res.g = decisive; return res; }
  if (res.f === res.m) return res;
  res.g = res.f > res.m ? 'f' : 'm';
  return res;
}
const ACC_GENDER = {
  f: { name: 'женский', icon: '👩' },
  m: { name: 'мужской', icon: '👨' },
  '': { name: 'не определён', icon: '❔' },
};
function accGenderOf(p, gd) {
  if (p.gender === 'f' || p.gender === 'm') return p.gender; // если парсер начнёт читать пол явно — верим записи
  return (gd || detectGender(p)).g || '';
}

// ---------- Имя для обращения (один расчёт для разбора и любых писем лиду) ----------
// Разбор профиля читает модель, которая пишет лиду «Привет, X». Пока в разборе лежали
// ДВА имени (шапка Instagram и дисплейное имя TG) плюс разрешение «сверь и выбери сам»,
// модель выбирала мимо: в TG человек — «Александр Гурьев», в письмо улетело «Алексей»,
// лид ответил «я не Алексей» и разбор умер. Имя обязан решать КОД, а модели доставаться
// одной строкой-фактом с запретом на выдумки.
// Приоритет источника: Telegram > Instagram. Письмо уходит в TG, и там человек подписался
// сам; шапка IG — это часто ниша/бренд («Фитнес Тренер Москва»), кличка, чужое имя из
// отзыва или уже переименованный аккаунт.
// Служебные слова: первым токеном в шапке IG почти всегда стоит ниша, а не имя.
const NAME_STOP = new Set([
  'фитнес', 'тренер', 'тренера', 'тренерский', 'нутрициолог', 'диетолог', 'психолог', 'эксперт',
  'наставник', 'коуч', 'врач', 'доктор', 'специалист', 'блог', 'блогер', 'инстаграм', 'инста',
  'телеграм', 'ютуб', 'тикток', 'риэлтор', 'риелтор', 'юрист', 'адвокат', 'бухгалтер', 'дизайнер',
  'предприниматель', 'бизнес', 'основатель', 'владелец', 'канал', 'проект', 'студия', 'центр',
  'клуб', 'кабинет', 'магазин', 'бренд', 'школа', 'курсы', 'курс', 'запись', 'онлайн', 'офлайн',
  'москва', 'спб', 'питер', 'казань', 'урал', 'рф', 'россия', 'фото', 'видео', 'рилс', 'бьюти',
  'красота', 'здоровье', 'мотивация', 'юмор', 'стиль', 'семья', 'мама', 'папа', 'любовь', 'мисс',
  'мистер', 'леди', 'fitness', 'trainer', 'coach', 'nutrition', 'nutri', 'health', 'wellness',
  'beauty', 'model', 'online', 'gym', 'club', 'studio', 'center', 'centre', 'store', 'shop',
  'official', 'channel', 'project', 'life', 'lifestyle', 'motivation', 'sport', 'doctor', 'reels',
  'instagram', 'telegram', 'youtube', 'video', 'photo', 'pro', 'the', 'mr', 'mrs', 'ms', 'dr', 'md',
]);
// Личное ли это имя (кириллица или латиница из баз выше) — по этому флагу разбор
// формулирует строку строже или мягче: «Кэт» мы не оспорим, «Дансор» — назовём ником.
function isKnownName(low) {
  return G_ALL_NAMES.has(low) || G_LAT_F_SET.has(low) || G_LAT_M_SET.has(low);
}
// Имя из произвольной строки, а не «первое слово»: известное имя ищем по всей строке
// (шапка IG обычно «Ниша | Имя»), иначе берём первое не-служебное слово. ALLCAPS
// приводим к «Александр»: «Привет, АЛЕКСАНДР)» выглядит как крик.
// Два флага, они означают разное: `known` — имя есть в базе имён (по нему решаем,
// какому источнику верить), `like` — слово просто оформлено как имя (с большой, без
// цифр): «Лена» в базе может и не быть, но писать «похоже на ник» про неё нельзя.
const NAME_LIKE = /^[\u0410-\u042F\u0401A-Z][\u0430-\u044F\u0451a-z]{1,11}$/;
function firstNameToken(s) {
  let weak = null;
  for (const t of String(s || '').split(/[^A-Za-z\u0400-\u04FF]+/)) {
    if (t.length < 2 || t.length > 15) continue;
    const low = t.toLowerCase().replace(/\u0451/g, '\u0435');
    if (NAME_STOP.has(low)) continue;
    const pretty = /^[A-Z\u0410-\u042F\u0401]+$/.test(t) && t.length > 2
      ? t.charAt(0) + t.slice(1).toLowerCase() : t;
    const cand = { name: pretty, known: isKnownName(low), like: NAME_LIKE.test(pretty) };
    if (cand.known) return cand;
    if (!weak) weak = cand;
  }
  return weak;
}
// src: { fullName, tgName, tgKind } → { name, src:'tg'|'ig'|'', known, like, alt }.
// name === '' — имени нет, и это нормальный ответ: лучше «Привет» без имени, чем не то имя.
function leadFirstName(src) {
  const s = src || {};
  const ig = firstNameToken(s.fullName);
  // Название канала/бота — не имя человека. tgKind известен, только когда карточку читали;
  // запись tgName воркер и так ведёт лишь для личных аккаунтов.
  const kind = String(s.tgKind || '');
  const tg = (kind && kind !== 'user') ? null : firstNameToken(s.tgName);
  // Порядок: известное имя из TG > известное из IG > любой токен из TG > любой из IG.
  // Известное бьёт неизвестное, потому что «Дансор» и «никому не звони» в TG — это ник,
  // а не имя. Но если ОБА имени известные и разные — верим TG: письмо уходит туда, и
  // там человек подписался сам (тот случай и был: TG «Александр», IG «Алексей»).
  const pick = (tg && tg.known ? tg : null) || (ig && ig.known ? ig : null) || tg || ig;
  const srcTg = !!(tg && pick === tg);
  const loser = pick ? (srcTg ? ig : tg) : null;
  let alt = loser ? loser.name : '';
  if (alt && pick && alt.toLowerCase().replace(/\u0451/g, '\u0435') === pick.name.toLowerCase().replace(/\u0451/g, '\u0435')) alt = '';
  return {
    name: pick ? pick.name : '',
    src: pick ? (srcTg ? 'tg' : 'ig') : '',
    known: !!(pick && pick.known),
    like: !!(pick && (pick.known || pick.like)),
    alt,
  };
}

// ---------- Пол ДОНОРА: фильтр АФК «у кого чекать списки» ----------
// Признак живёт именно здесь, а не продублирован в content.js и dashboard.js: бейдж
// «Квал: пол» в истории, фильтр /list у бота и выбор донора в АФК обязаны показывать
// один и тот же пол. Расходиться такое место будет незаметно: АФК прыгал бы не туда,
// а фильтр на экране утверждал бы обратное.
// Значения ключа: 'all' (по умолчанию — как было раньше) | 'f' | 'm'.
// При 'f'/'m' профиль с нераспознанным полом НЕ проходит: угадывать здесь — значит
// открыть АФК чужой список, поэтому ждём реального маркера, а не «похоже на».
const DONOR_GENDER_KEY = 'igx_afk_gender';
const DONOR_GENDERS = ['all', 'f', 'm'];
const DONOR_GENDER_NAME = { all: 'любой', f: 'женский', m: 'мужской' };
// detectGender — это ~15 regex-сканов по тексту, а АФК прогоняет фильтр по ВСЕЙ базе
// на каждый прыжок. Мемо держим по хэшу текста (fullName + bio): пересчёт только когда
// текст реально изменился. Хэш — один линейный проход, это на порядки дешевле самого
// detectGender; подписка из одних длин не годится — правка текста «символ в символ»
// оставила бы в кэше старый пол.
const donorGenderMemo = new Map(); // username(lower) -> { s: хэш текста, g: пол }
function genderTextHash(rec) {
  const a = (rec.fullName || '') + '\u0001' + (rec.tgName || '');
  const b = (rec.bio || '') + '\u0001' + (rec.tgBio || '');
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) | 0;
  for (let i = 0; i < b.length; i++) h = (h * 33 + b.charCodeAt(i)) | 0;
  return h;
}
function donorGenderOf(p, username) {
  const rec = p || {};
  const u = String(username || rec.username || '').toLowerCase();
  const s = genderTextHash(rec);
  const hit = donorGenderMemo.get(u);
  if (hit && hit.s === s) return hit.g;
  // Ник — один из доводов для пола (имя в нике), поэтому в расчёт уходит профиль
  // с юзернеймом, даже если в самой записи поля username нет.
  const g = accGenderOf(rec.username === u ? rec : Object.assign({}, rec, { username: u }));
  donorGenderMemo.set(u, { s, g });
  return g;
}
// Проходит ли донор фильтр: 'all' (и любое нераспознанное значение) — любой пол.
function donorGenderOk(p, username, want) {
  const w = DONOR_GENDERS.includes(want) ? want : 'all';
  if (w === 'all') return true;
  return donorGenderOf(p, username) === w;
}

// Квалификация одной записи по общему дампу storage: { gender, color, gd, ds, viewed }.
// Пороги сабов берутся из настроек сайта (igx_min/max_followers), а не из запроса, —
// чтобы «цвет» в боте означал ровно то же, что в столбце истории на дашборде.
function qualifyAccount(p, all, username) {
  const u = String(username || p.username || '').toLowerCase();
  const minF = parseInt(all[QUAL_MIN_KEY], 10) || 0;
  const maxF = parseInt(all[QUAL_MAX_KEY], 10) || 0;
  const ds = normalizeDoneFlags(all[QUAL_DONE_PREFIX + u]);
  const viewed = !!all[QUAL_VIEWED_PREFIX + u];
  const gd = detectGender(p);
  return {
    gd,
    ds,
    viewed,
    gender: accGenderOf(p, gd),
    color: accColorOf(Object.assign({}, p, { checkedAt: p.checkedAt || 0 }), { minF, maxF, ds, viewed }),
  };
}

// ---------- TG-аккаунты: «кому УЖЕ ПИСАЛ» (общий слой для сайта и бота) ----------
// Смысл: с двух аккаунтов одному и тому же человеку писать бессмысленно — он видя
// второе сообщение того же текста просто закроет диалог. Отметки «писал» живут в
// профиле лида (tgWrote), а снимаются со СПИСКА ДИАЛОГОВ аккаунта через локальный
// MTProto-мост tgbridge/. Предикаты здесь ОДНИ: и страница ④ дашборда, и /list
// рассылка в боте обязаны отвечать одинаково, иначе фильтр начнёт расходиться.
const TGACC_LIST_KEY = 'igx_tg_accounts';       // [{id,label,state,username,...}]
const TGACC_SET_KEY = 'igx_tgacc_settings';     // настройки страницы ④
const TGACC_DLG_PREFIX = 'igx_tgacc_dialogs_';  // зеркала снимка: {at, n}; сами peers живут на диске моста

// bridgeUrl — адрес моста (тот же приём, что у phoneBaseUrl у листа ③).
// deep — «глубокая» проверка: смотреть историю диалога на исходящие (дороже по FloodWait).
// autoSpam/spamMinH — мост сам спрашивает @SpamBot не чаще раза в N часов.
// excl — кого не брать в выборку рассылки: без TG и «не личка» (канал/бот).
const TGACC_SET_DEFAULTS = {
  bridgeUrl: 'http://localhost:8800',
  deep: false,
  autoSpam: true,
  spamMinH: 6,
  throttleMs: 700,
  excl: { noTG: true, notUser: true },
};

function tgaccSettings(all) {
  const raw = (all && all[TGACC_SET_KEY]) || {};
  const d = TGACC_SET_DEFAULTS;
  const out = {
    bridgeUrl: String(raw.bridgeUrl || d.bridgeUrl).trim().replace(/\/+$/, '') || d.bridgeUrl,
    deep: !!raw.deep,
    autoSpam: raw.autoSpam !== false,
    spamMinH: Math.min(168, Math.max(1, Number(raw.spamMinH) || d.spamMinH)),
    throttleMs: Math.min(60000, Math.max(100, Number(raw.throttleMs) || d.throttleMs)),
    excl: {
      noTG: raw.excl ? raw.excl.noTG !== false : d.excl.noTG,
      notUser: raw.excl ? raw.excl.notUser !== false : d.excl.notUser,
    },
  };
  return out;
}

function tgaccList(all) {
  const raw = all && all[TGACC_LIST_KEY];
  return Array.isArray(raw) ? raw.filter((a) => a && a.id) : [];
}

// Аккаунты, с которых имеет смысл что-то брать: только залогиненные.
function tgaccActiveIds(list) {
  return (Array.isArray(list) ? list : []).filter((a) => a && a.state === 'ok').map((a) => String(a.id));
}

// Ровный @хэндл из поля профиля: там живут и «@nick», и «t.me/nick», и полная ссылка,
// и «tg://resolve?domain=…». Без хэндла матчить нечем — это «не проверял», а не «не писал».
function tgaccHandle(p) {
  const raw = String((p && p.telegram) || '').trim().toLowerCase();
  if (!raw) return '';
  const dm = raw.match(/resolve\?domain=([a-z0-9_]{2,})/);
  if (dm) return dm[1];
  const m = raw.match(/(?:t\.me\/|@)\s*([a-z0-9_]{2,})/) || raw.match(/^([a-z0-9_]{2,})$/);
  return m ? m[1] : '';
}

// Состояние по всем аккаунтам сразу: «писал» сильнее — достаточно, что хоть один
// аккаунт уже светил этому лиду. «clean» только если проверяли и не нашли нигде.
function tgaccWroteInfo(p) {
  const w = (p && p.tgWrote) || null;
  if (!w || typeof w !== 'object') return { st: 'unknown', acc: '', at: 0, by: '' };
  let wrote = null;
  let clean = null;
  for (const id of Object.keys(w)) {
    const rec = w[id];
    if (!rec || (rec.st !== 'wrote' && rec.st !== 'clean')) continue;
    const at = Number(rec.at) || 0;
    const cand = { st: rec.st, acc: id, at, by: rec.by || 'dialog' };
    // Внутри своего вердикта берём самую свежую запись; а сами вердикты НЕ смешиваем:
    // «писал» сильнее, и clean-отметка второго аккаунта не должна затирать то, что
    // первый уже светил этому лиду (порядок ключей в объекте — не аргумент).
    if (rec.st === 'wrote') { if (!wrote || at > wrote.at) wrote = cand; }
    else if (!clean || at > clean.at) clean = cand;
  }
  if (wrote) return wrote;
  // «clean» = проверяли хотя бы одним аккаунтом и не нашли: аккаунт тут не называем,
  // гордиться нечем, а вот дата последней проверки полезна.
  if (clean) return { st: 'clean', acc: '', at: clean.at, by: clean.by };
  return { st: 'unknown', acc: '', at: 0, by: '' };
}

// Одно слово для всех мест: 'wrote' | 'clean' | 'unknown'.
function tgaccWroteState(p) { return tgaccWroteInfo(p).st; }

// Какие аккаунты светили лида (для бейджа «✍️ писал с tg1»). accIds — ограничение
// выборкой (обычно активные аккаунты страницы ④); пусто = считаем все отметки.
function tgaccWroteBy(p, accIds) {
  const w = (p && p.tgWrote) || null;
  if (!w || typeof w !== 'object') return [];
  const want = Array.isArray(accIds) && accIds.length ? accIds.map(String) : null;
  return Object.keys(w).filter((id) => {
    if (!w[id] || w[id].st !== 'wrote') return false;
    return !want || want.indexOf(String(id)) >= 0;
  });
}

