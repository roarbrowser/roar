// Runs in a hidden Outlook page Roar loaded (outlook.cloud.microsoft, also through the
// Defender for Cloud Apps proxy). Reads unread inbox mail with Outlook's own same-origin
// service and the bearer token the web app sends (its token cache is encrypted), then
// reports "__roar_outlook__ <json>": {unread, items: [{title, detail, url}]} or {error}.
(() => {
  const report = (o) => console.debug('__roar_outlook__ ' + JSON.stringify(o));
  // Keep the latest token Outlook sends; it renews it before it expires.
  if (!window.__roarOlHooked) {
    window.__roarOlHooked = true;
    const keep = (v) => { if (/^Bearer /i.test(v || '')) window.__roarOlAuth = v; };
    const f = window.fetch;
    window.fetch = function (input, init) {
      try { keep(new Headers((init && init.headers) || (input && input.headers) || {}).get('authorization')); } catch {}
      return f.apply(this, arguments);
    };
    const set = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.setRequestHeader = function (k, v) {
      if (/^authorization$/i.test(k)) keep(v);
      return set.apply(this, arguments);
    };
  }
  const T = (t) => t + ':#Exchange';
  const call = async (action, body) => {
    const r = await fetch('/owa/service.svc?action=' + action, {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json; charset=utf-8', action, authorization: window.__roarOlAuth },
      body: JSON.stringify({ __type: T(action + 'JsonRequest'), Header: { __type: T('JsonRequestHeaders'), RequestServerVersion: 'Exchange2016' }, Body: body }),
    });
    if (!r.ok) throw new Error('Outlook returned ' + r.status);
    const m = (await r.json()).Body.ResponseMessages.Items[0];
    if (m.ResponseClass !== 'Success') throw new Error(m.MessageText || m.ResponseCode || 'Outlook error');
    return m;
  };
  const inbox = [{ __type: T('DistinguishedFolderId'), Id: 'inbox' }];
  (async () => {
    try {
      // Outlook sends its first authorized request within seconds of loading; give it 90.
      for (let i = 0; i < 180 && !window.__roarOlAuth; ++i) await new Promise((r) => setTimeout(r, 500));
      if (!window.__roarOlAuth) throw new Error('No Outlook token seen');
      const folder = await call('GetFolder', { __type: T('GetFolderRequest'), FolderShape: { __type: T('FolderResponseShape'), BaseShape: 'Default' }, FolderIds: inbox });
      const found = await call('FindItem', {
        __type: T('FindItemRequest'),
        ItemShape: { __type: T('ItemResponseShape'), BaseShape: 'Default', AdditionalProperties: [{ __type: T('PropertyUri'), FieldURI: 'ConversationId' }] },
        ParentFolderIds: inbox, Traversal: 'Shallow',
        Restriction: { __type: T('RestrictionType'), Item: { __type: T('IsEqualTo'), Item: { __type: T('PropertyUri'), FieldURI: 'message:IsRead' },
          FieldURIOrConstant: { __type: T('FieldURIOrConstantType'), Item: { __type: T('Constant'), Value: 'false' } } } },
        SortOrder: [{ __type: T('SortResults'), Order: 'Descending', Path: { __type: T('PropertyUri'), FieldURI: 'DateTimeReceived' } }],
        Paging: { __type: T('IndexedPageView'), BasePoint: 'Beginning', Offset: 0, MaxEntriesReturned: 25 },
      });
      const items = (found.RootFolder.Items || []).map((m) => {
        const id = (m.ConversationId || m.ItemId || {}).Id || '';
        const from = m.From && m.From.Mailbox ? m.From.Mailbox.Name || m.From.Mailbox.EmailAddress : '';
        const when = m.DateTimeSent ? new Date(m.DateTimeSent).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        return { title: m.Subject || '(no subject)', detail: [from, when].filter(Boolean).join(' · '), url: location.origin + '/mail/inbox/id/' + encodeURIComponent(id) };
      });
      report({ unread: folder.Folders[0].UnreadCount || 0, items });
    } catch (e) {
      report({ error: String(e.message || e) });
    }
  })();
})();
