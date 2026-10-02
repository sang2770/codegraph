/**
 * The "interview before planning" step of `/implement`, after the brainstorming
 * stage of Superpowers: when a request leaves decisions only the user can make,
 * ask for them first instead of writing a plan around guesses.
 *
 * The model decides whether an interview is needed, and says so with a machine
 * marker rather than a heading, because headings are translated into the user's
 * language. Kept free of `vscode` so the contract is testable.
 */
export const INTERVIEW_MARKER = '<!-- codebrain-interview -->';

export type InterviewMode = 'ask' | 'answered' | 'off';

/** True when the model chose to interview instead of planning. */
export function isInterviewReply(text: string): boolean {
  return text.trimStart().slice(0, 300).includes(INTERVIEW_MARKER);
}

const SKIP_INTERVIEW =
  /\b(no questions?|don'?t ask|do not ask|skip (the )?(questions?|interview)|without (asking|questions)|just (plan|do it)|use (the )?(defaults?|recommendations?))\b|không cần hỏi|đừng hỏi|không hỏi|khỏi hỏi|bỏ qua câu hỏi|dùng (mặc định|đề xuất)/i;

/** The user already said not to ask, or to take the defaults. */
export function wantsNoInterview(prompt: string): boolean {
  return SKIP_INTERVIEW.test(prompt);
}

/** What an `/implement` turn does about interviewing, given the setting and thread state. */
export function interviewMode(options: {
  setting: string | undefined;
  prompt: string;
  previousWasInterview: boolean;
}): InterviewMode {
  if (options.previousWasInterview) return 'answered';
  if (options.setting === 'off' || wantsNoInterview(options.prompt)) return 'off';
  return 'ask';
}

const ASK = `

## Interview first (decide before you plan)
Decide whether the request leaves decisions that only the user can make AND that would change the plan: scope, user-visible behavior, edge cases, compatibility, data migration, performance or security targets. If the ticket's acceptance criteria already settle them, or the code evidence answers them, do NOT interview: write the plan as specified above.

Otherwise reply with ONLY an interview — no plan, no other section — in this structure:
${INTERVIEW_MARKER}
# <a short title in the user's language meaning "Before I plan: <topic>">
One or two sentences on what you checked in the code or ticket (with file:line), so the user sees the questions are grounded.
Then at most 5 numbered questions, the answer that would change the plan most first. Each question is one sentence, followed by 2-3 lettered options and a line "Recommended: <letter> — <one-line reason>". Never ask what the code or ticket already answers, and never ask about style or naming.
End with one sentence telling the user to answer with letters (for example "1A 2B") or to say "use the recommendations", and that you will then write the plan.`;

const ANSWERED = `

## The interview is done
Earlier in this conversation you asked the user clarifying questions, and their latest message answers them. Do NOT interview again. Treat "use the recommendations" (or any equivalent) as accepting every Recommended option. Record each decision under "## Acceptance criteria" as coming from the user, and write the plan as specified above. If an answer contradicts the ticket, say so under "## Open questions".`;

/** Text appended to the implement instructions for this turn. */
export function interviewInstructions(mode: InterviewMode): string {
  return mode === 'ask' ? ASK : mode === 'answered' ? ANSWERED : '';
}
