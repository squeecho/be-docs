// pdf.js 6.x는 "구형 브라우저용" 빌드에서도 최신 크롬에만 있는 기능 몇 가지를 그대로 쓴다.
// 업데이트가 안 된 웹뷰(안드로이드 14 기본 웹뷰가 크롬 113대)에서는 PDF를 못 열고 내장 렌더러로 넘어가
// 비밀번호·도장·서식 칸 값이 빠지거나, 열려도 쪽 내용이 비고 글자 고르기가 안 된다.
// pdf.js보다 먼저(화면과 작업 스레드 양쪽에서) 불러 빈 곳만 채운다. pdf.js가 스스로 채우는 기능
// (Uint8Array 16진·base64, Set 연산, Iterator 도우미, Math.sumPrecise, bytes())은 건드리지 않는다.

// 크롬 119
if (typeof Promise.withResolvers !== 'function') {
  Promise.withResolvers = function withResolvers() {
    let resolve;
    let reject;
    const promise = new this((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// 크롬 128
if (typeof Promise.try !== 'function') {
  Promise.try = function tryCall(fn, ...args) {
    return new this((resolve) => resolve(fn(...args)));
  };
}

// 크롬 114. 길이가 같으면 내용을 옮기고(복사 없음), 다르면 새 버퍼에 복사한다.
if (typeof ArrayBuffer.prototype.transferToFixedLength !== 'function') {
  Object.defineProperty(ArrayBuffer.prototype, 'transferToFixedLength', {
    configurable: true,
    writable: true,
    value: function transferToFixedLength(newLength = this.byteLength) {
      if (newLength === this.byteLength) return structuredClone(this, { transfer: [this] });
      const copy = new ArrayBuffer(newLength);
      new Uint8Array(copy).set(new Uint8Array(this, 0, Math.min(newLength, this.byteLength)));
      return copy;
    },
  });
}

// 크롬 126
if (typeof URL.parse !== 'function') {
  URL.parse = function parse(url, base) {
    try {
      return new URL(url, base);
    } catch {
      return null;
    }
  };
}

// 크롬 124: for await (const chunk of readableStream). 글자 층(고르기·복사)이 이것으로 글자를 받는다.
if (typeof ReadableStream !== 'undefined' && !ReadableStream.prototype[Symbol.asyncIterator]) {
  const values = function values({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result;
        } catch (e) {
          reader.releaseLock();
          throw e;
        }
      },
      async return(value) {
        const cancelled = preventCancel ? null : reader.cancel(value);
        reader.releaseLock();
        await cancelled;
        return { done: true, value };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  };
  Object.defineProperty(ReadableStream.prototype, 'values', { configurable: true, writable: true, value: values });
  Object.defineProperty(ReadableStream.prototype, Symbol.asyncIterator, { configurable: true, writable: true, value: values });
}
