// 実行環境をエッジに指定（超高速化）
export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  try {
    // 1. クエリから宛先URLを取得
    // (例: /api/proxy?target=https://example.com)
    const url = new URL(req.url);
    const targetUrlString = url.searchParams.get('target');

    // targetパラメータがない場合はエラー
    if (!targetUrlString) {
      return new Response('?target= クエリパラメータが必要です。', { status: 400 });
    }

    const targetUrl = new URL(targetUrlString);

    // 2. 宛先にリクエストを実行
    const response = await fetch(targetUrl.toString(), {
      method: req.method,
      headers: req.headers, // ヘッダーをそのまま転送
      redirect: 'follow', // リダイレクトに従う
    });

    // 3. レスポンスヘッダーを取得・加工
    const headers = new Headers(response.headers);
    
    // セキュリティ関連のヘッダーを削除 (ミラーリング表示のため)
    // これにより、iframeや外部リソースの埋め込み制限を解除
    headers.delete('Content-Security-Policy');
    headers.delete('X-Frame-Options');
    headers.delete('Cross-Origin-Embedder-Policy');

    // 4. コンテンツタイプに応じて処理を分岐
    const contentType = headers.get('Content-Type') || '';

    // 4a. HTMLの場合: 中身のリンクを書き換える
    if (contentType.includes('text/html')) {
      let html = await response.text();

      // このプロキシ自体のURL (例: /api/proxy?target=)
      // Vercelが提供するヘッダーからホスト名を取得
      const proxyPrefix = (req.headers.get('x-forwarded-proto') || 'http') + '://' + req.headers.get('host') + '/api/proxy?target=';

      // HTML内の全URLをプロキシ経由に書き換える関数
      const rewriteUrl = (match, attribute, quote, url) => {
        try {
          // data: や mailto: スキームは書き換えない
          if (url.startsWith('data:') || url.startsWith('mailto:')) {
            return match;
          }
          
          // URLを絶対パスに解決 (例: /foo.css -> https://original.com/foo.css)
          const absoluteUrl = new URL(url, targetUrl.href).href;
          // 新しいプロキシURLを返す
          return `${attribute}=${quote}${proxyPrefix}${encodeURIComponent(absoluteUrl)}${quote}`;
        } catch (e) {
          // 無効なURLなどはそのまま返す
          return match;
        }
      };
      
      // href="..." や src="..." や action="..." 属性を正規表現で置換
      html = html.replace(/(href|src|action)=(["'])([^"']+)\2/g, rewriteUrl);

      // CSS内の url(...) を書き換える (簡易版)
      html = html.replace(/url\((["']?)(?!data:)([^)"']+)\1\)/g, (match, quote, url) => {
         try {
           const absoluteUrl = new URL(url, targetUrl.href).href;
           return `url(${quote}${proxyPrefix}${encodeURIComponent(absoluteUrl)}${quote})`;
         } catch(e) {
           return match;
         }
      });
      
      // 書き換えたHTMLを新しいレスポンスとして返す
      return new Response(html, {
        status: response.status,
        statusText: response.statusText,
        headers: headers,
      });
    }

    // 4b. HTML以外 (CSS, JS, 画像など) の場合: そのまま転送
    // (これらのリソースは、HTMLが書き換えられた結果として、このproxy.js経由で再度リクエストされます)
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: headers,
    });

  } catch (e) {
    console.error(e);
    return new Response('Proxy error: ' + e.message, { status: 502 });
  }
}
