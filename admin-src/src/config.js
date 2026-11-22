/* 웹 설정값(공개용). 서버 비밀키가 아닙니다. */
const local = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !/[?&]live\b/.test(location.search);
export const CONFIG = {
  firebase: {
    apiKey: 'AIzaSyCoHkQUJX7tRRLRra-93824SOHTFzaahR0',
    authDomain: 'raintempolab.firebaseapp.com',
    projectId: 'raintempolab',
    storageBucket: 'raintempolab.firebasestorage.app',
    messagingSenderId: '361749729991',
    appId: '1:361749729991:web:dea7d4f4f814c8cf2f64e2'
  },
  region: 'asia-northeast3',
  emulator: local ? location.hostname : ''
};
