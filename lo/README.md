Glue scripts from @matbee/libreoffice-converter 2.7.2 (MPL-2.0), copied unmodified from
https://unpkg.com/@matbee/libreoffice-converter@2.7.2/ (dist/browser.js, dist/browser.worker.global.js,
wasm/soffice.js, wasm/soffice.worker.js). Source: https://github.com/matbeedotcom/libreoffice-document-converter
They are same-origin copies because browsers only allow same-origin web workers. The large engine files
(soffice.wasm, soffice.data) are loaded from unpkg at run time.
