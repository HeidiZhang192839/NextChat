if ('serviceWorker' in navigator) {
  window.addEventListener('DOMContentLoaded', function () {
    // the worker claims this page when it activates (see serviceWorker.js),
    // so there is no need to reload the page, which would cut off a reply being generated
    navigator.serviceWorker.register('/serviceWorker.js').then(function (registration) {
      console.log('ServiceWorker registration successful with scope: ', registration.scope);
      registration.update().then(res => {
        console.log('ServiceWorker registration update: ', res);
      });
      window._SW_ENABLED = true
    }, function (err) {
      console.error('ServiceWorker registration failed: ', err);
    });
  });
}
