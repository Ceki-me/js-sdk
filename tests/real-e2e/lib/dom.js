// DOM eval helper for js-sdk real-e2e cases.
// Wraps browser.send({ method: 'Runtime.evaluate' }) so cases can poke at
// fixture state (window.__keyTimes, __pointerLog, __qaReset, ...).

async function evalInPage(browser, expression, opts = {}) {
  const res = await browser.send({
    method: 'Runtime.evaluate',
    params: {
      expression,
      returnByValue: true,
      awaitPromise: !!opts.awaitPromise,
      timeout: opts.timeout ?? 5000,
    },
  });
  if (res && res.exceptionDetails) {
    const msg =
      (res.exceptionDetails.exception && res.exceptionDetails.exception.description) ||
      res.exceptionDetails.text ||
      'eval threw';
    throw new Error(`evalInPage: ${msg}`);
  }
  return res && res.result && 'value' in res.result ? res.result.value : undefined;
}

module.exports = { evalInPage };
