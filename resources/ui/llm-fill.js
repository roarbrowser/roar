// Puts |text| into an LLM chat page's message box, replacing any draft,
// without sending it.
// Injected by Controller::OnLoading once the tab Roar opened has loaded; the
// box renders late on these apps, so it polls for up to 20 seconds.
window.__roarFill = (text) => {
  const selectors = [
    '#prompt-textarea',                     // ChatGPT
    'div.ProseMirror[contenteditable=true]', // Claude
    'rich-textarea .ql-editor',             // Gemini
    // Grok, Le Chat, DeepSeek, Copilot, Kimi: unverified against signed-in pages; the generic
    // fallbacks below catch them if their DOM moved.
    'textarea#userInput',                   // Copilot
    'textarea#chat-input',                  // DeepSeek
    '.chat-input-editor[contenteditable=true]', // Kimi
    'textarea#ask-input, textarea',         // Perplexity, Grok, Le Chat, fallback
    '[contenteditable=true][role=textbox]',
  ];
  const fill = (box) => {
    box.focus();
    if (box.tagName === 'TEXTAREA') {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      // Editors (ProseMirror, Quill) keep their own model; insertText goes
      // through it, replacing whatever selectAll picked up inside the box.
      document.execCommand('selectAll');
      document.execCommand('insertText', false, text);
    }
  };
  const started = Date.now();
  const tick = () => {
    for (const s of selectors) {
      const box = document.querySelector(s);
      if (box && box.offsetParent !== null) return fill(box);
    }
    if (Date.now() - started < 20000) setTimeout(tick, 300);
  };
  tick();
};
