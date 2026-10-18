/** An error whose message is safe to show to API clients. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

/** Raised by the database layer; `message` carries the SQL exception code. */
export class DbError extends Error {
  constructor(
    message: string,
    public readonly sqlState?: string,
  ) {
    super(message);
    this.name = 'DbError';
  }
}

const KNOWN_DB_ERRORS: Record<string, { status: number; message: string }> = {
  TEST_NOT_AVAILABLE: { status: 404, message: 'This test is not available. Please check the link.' },
  MAX_ATTEMPTS_REACHED: { status: 403, message: 'You have used all the attempts allowed for this test.' },
  INVALID_NAME: { status: 400, message: 'Please enter your name (up to 80 characters).' },
  INVALID_TOKEN: { status: 400, message: 'Invalid attempt credentials.' },
  ATTEMPT_NOT_FOUND: { status: 404, message: 'This attempt was not found.' },
  ATTEMPT_CLOSED: { status: 409, message: 'This attempt has already been submitted.' },
  DEADLINE_PASSED: { status: 409, message: 'Time is up. Answers saved before the deadline have been submitted.' },
  ATTEMPT_STILL_ACTIVE: { status: 409, message: 'This attempt is still in progress.' },
  ATTEMPT_NOT_SUBMITTED: { status: 409, message: 'This attempt has not been submitted yet.' },
  INVALID_SUBMISSION_TYPE: { status: 400, message: 'Invalid submission.' },
  INVALID_PAYLOAD: { status: 400, message: 'Invalid request.' },
  INVALID_MARKS: { status: 400, message: "Marks must be between 0 and the question's maximum." },
  QUESTION_NOT_FOUND: { status: 404, message: 'Question not found.' },
  TEST_NOT_FOUND: { status: 404, message: 'Test not found.' },
  TOPIC_SUBJECT_MISMATCH: { status: 400, message: 'The topic does not belong to the selected subject.' },
  TEST_LOCKED: {
    status: 409,
    message: 'This test already has attempts, so its questions can no longer change. Duplicate it to create a new version.',
  },
  TEST_HAS_NO_QUESTIONS: { status: 422, message: 'A published test needs at least one question.' },
  USER_NOT_FOUND: { status: 404, message: 'User not found.' },
  SETUP_ALREADY_COMPLETE: { status: 409, message: 'Setup is already complete. Please sign in.' },
  CANNOT_REMOVE_SELF: { status: 409, message: 'You cannot remove your own administrator account.' },
  STUDENT_ACCOUNT_REQUIRED: { status: 401, message: 'Please sign in with a student account to take this test.' },
  REQUEST_NOT_FOUND: { status: 404, message: 'This access request was not found or was already handled.' },
  NOT_IN_CLASS: { status: 403, message: 'This test is only for students in the class it was assigned to. Ask your teacher for the class code.' },
  LAST_ADMIN: { status: 409, message: 'At least one administrator must remain.' },
  FORBIDDEN: { status: 403, message: 'You do not have permission to do that.' },
};

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DbError) {
    const known = KNOWN_DB_ERRORS[error.message];
    if (known) return new AppError(error.message, known.status, known.message);
    switch (error.sqlState) {
      case '42501':
        return new AppError('FORBIDDEN', 403, KNOWN_DB_ERRORS.FORBIDDEN.message);
      case '23505':
        return new AppError('CONFLICT', 409, 'A record with the same name already exists.');
      case '23503':
        return new AppError('IN_USE', 409, 'This record is still in use and cannot be removed.');
      case '23514':
      case '22P02':
        return new AppError('INVALID_DATA', 400, 'Some values are not valid.');
    }
  }
  return new AppError('INTERNAL_ERROR', 500, 'Something went wrong. Please try again.');
}

export function isErrorCode(error: unknown, code: string): boolean {
  return (error instanceof DbError && error.message === code) || (error instanceof AppError && error.code === code);
}

export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} not found.`);
