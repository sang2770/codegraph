export interface ResponseLanguage {
  code: string;
  name: string;
  source: 'message' | 'vscode';
}

const LANGUAGE_NAMES: Record<string, string> = {
  ar: 'Arabic',
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  hi: 'Hindi',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  pt: 'Portuguese',
  ru: 'Russian',
  th: 'Thai',
  tr: 'Turkish',
  vi: 'Vietnamese',
  zh: 'Chinese',
};

const LATIN_LANGUAGE_WORDS: Record<string, readonly string[]> = {
  vi: [
    'anh',
    'cai',
    'cho',
    'chuc',
    'co',
    'cua',
    'danh',
    'dung',
    'giai',
    'giup',
    'hoat',
    'khong',
    'kiem',
    'lam',
    'luong',
    'muc',
    'nay',
    'nghia',
    'nhu',
    'phan',
    'review',
    'sua',
    'the',
    'thich',
    'toi',
    'tra',
    'workflow',
  ],
  en: [
    'analyze',
    'code',
    'does',
    'explain',
    'flow',
    'how',
    'purpose',
    'review',
    'risk',
    'the',
    'this',
    'what',
    'why',
    'workflow',
  ],
  es: ['analiza', 'código', 'cómo', 'este', 'explica', 'flujo', 'para', 'qué', 'revisa'],
  fr: ['analyse', 'ce', 'comment', 'code', 'explique', 'flux', 'pourquoi', 'quel', 'révise'],
  de: ['analysiere', 'code', 'dieser', 'erkläre', 'funktioniert', 'prüfe', 'warum', 'wie'],
  pt: ['analise', 'código', 'como', 'este', 'explique', 'fluxo', 'por', 'revise'],
  id: ['alur', 'analisis', 'bagaimana', 'ini', 'jelaskan', 'kode', 'mengapa', 'tinjau'],
  it: ['analizza', 'codice', 'come', 'questo', 'perché', 'revisione', 'spiega'],
  tr: ['akış', 'analiz', 'açıkla', 'bu', 'kod', 'nasıl', 'neden', 'incele'],
};

function fromLocale(locale: string): ResponseLanguage {
  const code = locale.toLowerCase().split(/[-_]/)[0] || 'en';
  return {
    code,
    name: LANGUAGE_NAMES[code] ?? locale,
    source: 'vscode',
  };
}

function messageLanguage(code: string): ResponseLanguage {
  return {
    code,
    name: LANGUAGE_NAMES[code] ?? code,
    source: 'message',
  };
}

function containsNaturalWords(text: string): boolean {
  return (text.match(/\p{L}+/gu) ?? []).some((word) => word.length >= 2);
}

export function detectResponseLanguage(
  message: string,
  vscodeLocale: string,
): ResponseLanguage {
  const text = message.trim();
  const fallback = fromLocale(vscodeLocale);
  if (!text || !containsNaturalWords(text)) {
    return fallback;
  }

  if (/[\u3040-\u30ff]/u.test(text)) return messageLanguage('ja');
  if (/[\uac00-\ud7af]/u.test(text)) return messageLanguage('ko');
  if (/[\u4e00-\u9fff]/u.test(text)) return messageLanguage('zh');
  if (/[\u0400-\u04ff]/u.test(text)) return messageLanguage('ru');
  if (/[\u0600-\u06ff]/u.test(text)) return messageLanguage('ar');
  if (/[\u0e00-\u0e7f]/u.test(text)) return messageLanguage('th');
  if (/[\u0900-\u097f]/u.test(text)) return messageLanguage('hi');

  // Vietnamese-specific letters and stacked tone marks are a stronger signal
  // than shared Latin accents used by French, Portuguese, and Spanish.
  if (/[ăâđêôơưĂÂĐÊÔƠƯ]|[ạảấầẩẫậắằẳẵặẹẻẽếềểễệịỉĩọỏốồổỗộớờởỡợụủũứừửữựỵỷỹ]/u.test(text)) {
    return messageLanguage('vi');
  }

  const tokens = (text.toLocaleLowerCase().match(/\p{L}+/gu) ?? []).map((word) =>
    word.normalize('NFC'),
  );
  let bestCode = fallback.code;
  let bestScore = 0;

  for (const [code, vocabulary] of Object.entries(LATIN_LANGUAGE_WORDS)) {
    const words = new Set(vocabulary);
    const score = tokens.reduce(
      (total, token) => total + (words.has(token) ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      bestCode = code;
      bestScore = score;
    }
  }

  // One strong natural-language marker is enough for a short chat command.
  // With no marker, preserve the user's VS Code display language.
  return bestScore > 0 ? messageLanguage(bestCode) : fallback;
}

/**
 * Language for a multi-turn conversation.
 *
 * A short follow-up like “more detail” carries no language signal, so detecting
 * per message would silently switch a Vietnamese conversation to English
 * mid-thread. Walking back to the most recent message that *did* carry a signal
 * keeps one conversation in one language.
 *
 * @param prompts User messages oldest to newest.
 */
export function detectConversationLanguage(
  prompts: readonly string[],
  vscodeLocale: string,
): ResponseLanguage {
  for (let index = prompts.length - 1; index >= 0; index -= 1) {
    const detected = detectResponseLanguage(prompts[index] ?? '', vscodeLocale);
    if (detected.source === 'message') {
      return detected;
    }
  }
  return fromLocale(vscodeLocale);
}

export function responseLanguageInstruction(language: ResponseLanguage): string {
  return [
    `Response language: ${language.name} (${language.code}).`,
    `Write the entire report in ${language.name}, including every heading, table label, verdict, explanation, and diagram label.`,
    'Keep source-code identifiers, file paths, API names, and quoted code in their original spelling.',
    'If the user mixes languages, follow the dominant natural language of the latest message.',
  ].join(' ');
}
