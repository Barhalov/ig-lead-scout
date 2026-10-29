// Begin header extraction at document_start; waiting for document_idle can consume
// the whole check deadline on pages loading large image/video resources.
chrome.runtime.sendMessage({type:'isQuickCheck'}).then(mode => {
  if (mode?.isQuickCheck) return laptopQuickProfile();
}).catch(error => console.warn('Quick profile bootstrap', error));
