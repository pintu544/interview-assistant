// Race non-abortable operations against the solve deadline without leaking listeners.
export function abortError(): Error {
  const error = new Error('Operation cancelled');
  error.name = 'AbortError';
  return error;
}

export function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      signal.removeEventListener('abort', aborted);
      reject(abortError());
    };
    signal.addEventListener('abort', aborted, { once: true });
    // Attach rejection handling even when already aborted to consume late failures safely.
    operation.then(
      (value) => {
        signal.removeEventListener('abort', aborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      },
    );
    if (signal.aborted) aborted();
  });
}
