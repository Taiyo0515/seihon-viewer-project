/**
 * 通信の書き換えルール(declarativeNetRequest)の組み立て。
 *
 * Manifest V3 ではブロッキングの webRequest が使えないため、
 * Chrome 128 以降で使える「応答ヘッダーを条件にしたルール」で PDF を判定します。
 *
 * ■ 自動起動(launchMode = "auto")のとき
 *   PDFと判断できる「ページとしての読み込み(main_frame)」を、製本ビューアへリダイレクトします。
 *   ・Content-Type が application/pdf
 *   ・(強制ダウンロード対策がオンなら)Content-Disposition: attachment でも同様に開く
 *   ・(同上)Content-Type が application/octet-stream 等でも、URL が .pdf で終わる
 *   ・(同上)Content-Type が octet-stream 等(または無し)で、ファイル名が .pdf
 *
 * ■ 手動起動(launchMode = "manual")のとき
 *   リダイレクトはしません。強制ダウンロード対策がオンなら、
 *   ダウンロード指示を外して Chrome 標準ビューアで「表示」されるよう応答ヘッダーを書き換えます。
 *
 * PDFと判断できないもの(例: .pdf でない octet-stream)は触りません。
 * POST の応答は再取得できないため対象外です(Chrome 標準の動作のまま)。
 */

import { viewerBaseUrl } from "../common/viewer-url.js";

/** PDF とみなす Content-Type */
export const PDF_CONTENT_TYPES = [
  "application/pdf",
  "application/pdf;*",
  "application/x-pdf",
  "application/x-pdf;*",
  "application/acrobat",
  "application/vnd.pdf",
  "text/pdf",
  "text/x-pdf",
];

/** 「中身の種類を明示しない」Content-Type(PDFなのにこれで配信するサイトがある) */
export const OCTET_CONTENT_TYPES = [
  "application/octet-stream",
  "application/octet-stream;*",
  "binary/octet-stream",
  "binary/octet-stream;*",
  "application/x-download",
  "application/x-download;*",
  "application/force-download",
  "application/force-download;*",
  "application/download",
  "application/download;*",
  "application/unknown",
  "application/binary",
  "application/x-unknown",
];

/** Content-Disposition のファイル名が .pdf で終わる */
export const PDF_DISPOSITION_VALUES = ["*.pdf", '*.pdf"*', "*.pdf'*", "*.pdf;*", "*.pdf *"];

/** URL のパスが .pdf で終わる(クエリ・; 以降は問わない)。全体一致させる。 */
export const PDF_URL_REGEX = "^https?://[^?#]*\\.pdf(?:[;?#].*)?$";

/** ルールID(動的ルール) */
export const RULE_IDS = Object.freeze({
  REDIRECT_PDF: 1,
  REDIRECT_PDF_UNGUARDED: 2,
  REDIRECT_OCTET_URL: 3,
  REDIRECT_OCTET_DISPOSITION: 4,
  REDIRECT_FILE: 5,
  MODIFY_PDF_ATTACHMENT: 11,
  MODIFY_OCTET_URL: 12,
  MODIFY_OCTET_DISPOSITION: 13,
});

const MAIN_FRAME = ["main_frame"];

function redirectAction() {
  return {
    type: "redirect",
    // 宣言的ルールではURLエンコードできないため、元のURLをそのまま後ろに付ける。
    // ビューア側で生の形も解釈する(common/viewer-url.js)。
    redirect: { regexSubstitution: `${viewerBaseUrl()}?src=\\0` },
  };
}

/** 応答ヘッダーを「PDFとして表示」させる書き換え */
const DISPLAY_AS_PDF_HEADERS = [
  { header: "content-type", operation: "set", value: "application/pdf" },
  { header: "content-disposition", operation: "remove" },
];
const REMOVE_DISPOSITION = [{ header: "content-disposition", operation: "remove" }];

function union(a, b) {
  return [...new Set([...(a || []), ...(b || [])])];
}

function withDomains(condition, { exclude = [], include = null } = {}) {
  const c = { ...condition };
  if (include && include.length) {
    c.requestDomains = include;
  }
  if (exclude.length) {
    c.excludedRequestDomains = exclude;
  }
  return c;
}

/**
 * 設定から動的ルールを組み立てる。
 * @param {object} settings 検証済みの設定
 * @param {{fileAccess:boolean}} env
 */
export function buildDynamicRules(settings, env = {}) {
  const rules = [];
  const autoEx = settings.autoExcludeSites || [];
  const guardEx = settings.guardEnabled ? settings.guardExcludeSites || [] : [];
  const guard = !!settings.guardEnabled;

  if (settings.launchMode === "auto") {
    // (1) Content-Type が PDF のもの。
    //     対策オン: ダウンロード指示があってもビューアで開く(対策の対象外サイトは除く)
    //     対策オフ: ダウンロード指示があるものはサイトの指示どおりダウンロードさせる
    const pdfCondition = {
      regexFilter: "^https?://.*$",
      resourceTypes: MAIN_FRAME,
      excludedRequestMethods: ["post"],
      responseHeaders: [{ header: "content-type", values: PDF_CONTENT_TYPES }],
    };
    if (guard) {
      rules.push({
        id: RULE_IDS.REDIRECT_PDF,
        priority: 10,
        action: redirectAction(),
        condition: withDomains(pdfCondition, { exclude: union(autoEx, guardEx) }),
      });
      const onlyUnguarded = guardEx.filter(d => !autoEx.includes(d));
      if (onlyUnguarded.length) {
        rules.push({
          id: RULE_IDS.REDIRECT_PDF_UNGUARDED,
          priority: 10,
          action: redirectAction(),
          condition: {
            ...withDomains(pdfCondition, { include: onlyUnguarded }),
            excludedResponseHeaders: [{ header: "content-disposition", values: ["attachment*"] }],
          },
        });
      }
    } else {
      rules.push({
        id: RULE_IDS.REDIRECT_PDF,
        priority: 10,
        action: redirectAction(),
        condition: {
          ...withDomains(pdfCondition, { exclude: autoEx }),
          excludedResponseHeaders: [{ header: "content-disposition", values: ["attachment*"] }],
        },
      });
    }

    if (guard) {
      const ex = union(autoEx, guardEx);
      // (2) octet-stream 等だが URL が .pdf で終わる
      rules.push({
        id: RULE_IDS.REDIRECT_OCTET_URL,
        priority: 9,
        action: redirectAction(),
        condition: withDomains(
          {
            regexFilter: PDF_URL_REGEX,
            isUrlFilterCaseSensitive: false,
            resourceTypes: MAIN_FRAME,
            excludedRequestMethods: ["post"],
            responseHeaders: [{ header: "content-type", values: OCTET_CONTENT_TYPES }],
          },
          { exclude: ex }
        ),
      });
      // (3) ファイル名が .pdf で、Content-Type が octet-stream 等(または無し)。
      //     responseHeaders は OR 条件なので、「Content-Type があり、かつ octet 系以外」を
      //     除外条件にして AND を表現する(PDF.js 公式拡張と同じ手法)。
      rules.push({
        id: RULE_IDS.REDIRECT_OCTET_DISPOSITION,
        priority: 8,
        action: redirectAction(),
        condition: withDomains(
          {
            regexFilter: "^https?://.*$",
            resourceTypes: MAIN_FRAME,
            excludedRequestMethods: ["post"],
            responseHeaders: [{ header: "content-disposition", values: PDF_DISPOSITION_VALUES }],
            excludedResponseHeaders: [
              { header: "content-type", excludedValues: OCTET_CONTENT_TYPES },
            ],
          },
          { exclude: ex }
        ),
      });
    }

    // (4) ローカルファイル。DNR が file:// を扱えるのは「ファイルの URL へのアクセス」が許可されている
    //     場合だけ。許可が無い場合は Service Worker の webNavigation 側で案内画面へ誘導する。
    if (settings.openLocalFiles && env.fileAccess) {
      rules.push({
        id: RULE_IDS.REDIRECT_FILE,
        priority: 10,
        action: redirectAction(),
        condition: {
          regexFilter: "^file://.*\\.pdf$",
          isUrlFilterCaseSensitive: false,
          resourceTypes: MAIN_FRAME,
        },
      });
    }
  } else if (guard) {
    // 手動起動: 自作ビューアへは切り替えず、Chrome 標準ビューアで「表示」されるようにする
    rules.push({
      id: RULE_IDS.MODIFY_PDF_ATTACHMENT,
      priority: 10,
      action: { type: "modifyHeaders", responseHeaders: REMOVE_DISPOSITION },
      condition: withDomains(
        {
          resourceTypes: MAIN_FRAME,
          excludedRequestMethods: ["post"],
          responseHeaders: [{ header: "content-type", values: PDF_CONTENT_TYPES }],
          // Content-Disposition があり、かつ attachment 以外(inline など)なら触らない
          excludedResponseHeaders: [
            { header: "content-disposition", excludedValues: ["attachment*"] },
          ],
        },
        { exclude: guardEx }
      ),
    });
    rules.push({
      id: RULE_IDS.MODIFY_OCTET_URL,
      priority: 9,
      action: { type: "modifyHeaders", responseHeaders: DISPLAY_AS_PDF_HEADERS },
      condition: withDomains(
        {
          regexFilter: PDF_URL_REGEX,
          isUrlFilterCaseSensitive: false,
          resourceTypes: MAIN_FRAME,
          excludedRequestMethods: ["post"],
          responseHeaders: [{ header: "content-type", values: OCTET_CONTENT_TYPES }],
        },
        { exclude: guardEx }
      ),
    });
    rules.push({
      id: RULE_IDS.MODIFY_OCTET_DISPOSITION,
      priority: 8,
      action: { type: "modifyHeaders", responseHeaders: DISPLAY_AS_PDF_HEADERS },
      condition: withDomains(
        {
          resourceTypes: MAIN_FRAME,
          excludedRequestMethods: ["post"],
          responseHeaders: [{ header: "content-disposition", values: PDF_DISPOSITION_VALUES }],
          excludedResponseHeaders: [
            { header: "content-type", excludedValues: OCTET_CONTENT_TYPES },
          ],
        },
        { exclude: guardEx }
      ),
    });
  }
  return rules;
}

/**
 * 「Chrome標準で開く」を押したタブで、次の1回の読み込みだけ自動切り替えをしないためのルール。
 * セッションルール(ブラウザを閉じると消える)として登録し、読み込みが確定したら削除する。
 * ダウンロード指示付きのPDFも標準ビューアで表示できるよう、ヘッダーも書き換える。
 */
export function buildBypassRules(tabId, baseId) {
  return [
    {
      id: baseId,
      priority: 1000,
      action: { type: "allow" },
      condition: { tabIds: [tabId], resourceTypes: MAIN_FRAME },
    },
    {
      id: baseId + 1,
      priority: 1001,
      action: { type: "modifyHeaders", responseHeaders: REMOVE_DISPOSITION },
      condition: {
        tabIds: [tabId],
        resourceTypes: MAIN_FRAME,
        responseHeaders: [{ header: "content-type", values: PDF_CONTENT_TYPES }],
      },
    },
    {
      id: baseId + 2,
      priority: 1001,
      action: { type: "modifyHeaders", responseHeaders: DISPLAY_AS_PDF_HEADERS },
      condition: {
        tabIds: [tabId],
        regexFilter: PDF_URL_REGEX,
        isUrlFilterCaseSensitive: false,
        resourceTypes: MAIN_FRAME,
        responseHeaders: [{ header: "content-type", values: OCTET_CONTENT_TYPES }],
      },
    },
    {
      id: baseId + 3,
      priority: 1001,
      action: { type: "modifyHeaders", responseHeaders: DISPLAY_AS_PDF_HEADERS },
      condition: {
        tabIds: [tabId],
        resourceTypes: MAIN_FRAME,
        responseHeaders: [{ header: "content-disposition", values: PDF_DISPOSITION_VALUES }],
        excludedResponseHeaders: [
          { header: "content-type", excludedValues: OCTET_CONTENT_TYPES },
        ],
      },
    },
  ];
}

/** ビューアが PDF を取得するときに、元のページのリファラを付けるルール */
export function buildRefererRule(id, tabId, host, referer) {
  return {
    id,
    priority: 1,
    action: {
      type: "modifyHeaders",
      requestHeaders: [{ header: "referer", operation: "set", value: referer }],
    },
    condition: {
      requestDomains: [host],
      resourceTypes: ["xmlhttprequest"],
      tabIds: [tabId],
      initiatorDomains: [chrome.runtime.id],
    },
  };
}
