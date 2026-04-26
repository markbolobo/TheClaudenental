# FB → Claude 書籤小工具安裝

## 安裝步驟（一次性）

1. Edge 開啟書籤列（Ctrl+Shift+B）
2. 在書籤列空白處右鍵 → 新增書籤
3. 名稱：`📤 送到 Claude`
4. 網址：貼上下方整段 `javascript:` 程式碼（**一定要連 `javascript:` 前綴一起貼**）
5. 儲存

## 使用方式

1. Edge 開任何 FB 貼文頁（登入狀態下）
2. 需要看完整留言的話，先手動點開「查看更多留言」
3. 點書籤欄的「📤 送到 Claude」
4. 看到 alert 「✓ 已送到 Claude」即成功
5. 到 TheClaudenental Chat → 點 ⚡ 心腹 → 點「📋 FB 暫存」→ 自動帶入並送出

## 程式碼（單行 bookmarklet）

```
javascript:(function(){try{var p=document.querySelector('[role="article"]')||document.querySelector('[data-pagelet*="FeedUnit"]')||document.body;var texts=Array.from(p.querySelectorAll('*')).filter(function(e){return e.children.length===0&&e.textContent.trim()}).map(function(e){return e.textContent.trim()});var u=Array.from(new Set(texts)).filter(function(t){return t.length>8&&!/^(讚|留言|分享|回覆|追蹤|關注|·|Like|Comment|Share|Reply|All reactions)$/i.test(t)});var author=(p.querySelector('h3 a,h4 a,strong a[role="link"]')||{}).textContent||'';var links=Array.from(p.querySelectorAll('a[href]')).map(function(a){return a.href}).filter(function(h){return h&&!h.includes('facebook.com/')&&!h.includes('fb.com/')&&!h.startsWith('javascript:')&&!h.includes('/privacy')&&!h.includes('/help')});var imgs=Array.from(p.querySelectorAll('img')).map(function(i){return i.src}).filter(function(s){return s&&s.includes('scontent')}).slice(0,10);var content=u.slice(0,100).join('\n');var comments=u.slice(100,300);var data={url:location.href,author:author.trim(),content:content,comments:comments,links:Array.from(new Set(links)),images:imgs};var host='http://100.115.110.21:3001';var blob=new Blob([JSON.stringify(data)],{type:'application/json'});var ok=navigator.sendBeacon(host+'/api/fb-push',blob);alert(ok?'✓ 已送到 Claude\n內文 '+content.length+' 字 / 留言 '+comments.length+' 段 / 連結 '+data.links.length:'✗ 送出失敗\n確認 TheClaudenental server 在運行');}catch(e){alert('✗ 錯誤：'+e.message)}})();
```

## 如果不在家用網路（Tailscale IP 不通）

把程式碼裡的 `http://100.115.110.21:3001` 改成你當時可連到的 server 位址（例如 `http://localhost:3001` 如果在同台電腦）。
