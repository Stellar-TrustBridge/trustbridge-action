/**
 * Internationalization (i18n) template layer for TrustBridge issue comments.
 *
 * Provides locale-aware comment templates with fallback to English.
 * Strings that appear in Markdown issue comments are externalized here,
 * making it easy for consumers to add new locales or adjust copy.
 */

export type Locale = 'en' | 'es' | 'pt' | 'ja' | 'fr' | 'de';

export interface CommentStrings {
  // Main heading
  heading: string;
  checkedAccount: string;
  horizon: string;
  asset: string;

  // Results section
  resultsHeading: string;

  // Validation gate section
  validationGateHeading: string;
  readyToProceed: string;
  blockedBy: string;
  passedChecks: string;
  failedChecks: string;

  // Balances section
  balancesHeading: string;
  xlmBalance: string;
  minimumRequired: string;

  // Setup cost estimate section
  setupCostHeading: string;
  minimumAccountBalance: string;
  baseReservePerTrustline: string;
  typicalMinimumToFund: string;

  // Add trustline section
  addTrustlineHeading: string;
  viewAccountOnLab: string;
  openTransactionBuilder: string;
  lobstrWallet: string;
  lobstrDescription: string;

  // SEP-0007 section (if enabled)
  sepWalletActionsHeading: string;
  sepWalletActionsDescription: string;
  sendXlmToActivate: string;

  // Remediation section
  remediationHeading: string;

  // Configuration summary section
  configurationSummaryHeading: string;
  inputColumn: string;
  valueColumn: string;
  failOnMissingTrue: string;
  failOnMissingFalse: string;
  stickyCommentTrue: string;
  stickyCommentFalse: string;
  waitUntilFundedTrue: string;
  waitUntilFundedFalse: string;
  waitUntilFundedTimeoutMs: string;
  waitUntilFundedIntervalMs: string;

  // Action outputs reference section
  outputsHeading: string;
  outputsDescription: string;
  outputColumn: string;
  valueRunColumn: string;
  descriptionColumn: string;
  accountFundedOutput: string;
  trustlineExistsOutput: string;
  xlmBalanceOutput: string;
  commentUrlOutput: string;

  // Metrics section
  metricsHeading: string;
  metricsDescription: string;

  // Check details (labels and details for common validation scenarios)
  accountFundedLabel: string;
  accountFundedPassDetail(address: string): string;
  accountFundedFailDetail(address: string): string;
  trustlineLabel(assetCode: string): string;
  trustlinePassDetail(assetCode: string, issuer: string): string;
  trustlineFailHasTrustlines(assetCode: string, issuer: string): string;
  trustlineFailNoTrustlines: string;
  xlmReserveLabel: string;
  xlmReservePassDetail(balance: string, required: string): string;
  xlmReserveFailDetail(balance: string, required: string): string;
  horizonAvailabilityLabel: string;

  // Remediation copy
  remediationAddTrustline(assetCode: string): string;
  remediationSendXlm(amount: string, address: string): string;
  remediationActivateAccount(address: string, minBalance: string, assetCode: string): string;
  remediationAccountNotFound(assetCode: string): string;
  remediationEstimatedSetupCost(cost: string): string;
  remediationHorizonError: string;

  // Cross-network mismatch copy
  networkMismatchDetected: string;
  networkMismatchConfiguredNetwork: string;
  networkMismatchActiveNetwork: string;
  networkMismatchFix: string;
  networkMismatchUpdateUrl: string;
}

/**
 * English (en) locale strings.
 */
const EN: CommentStrings = {
  heading: 'TrustBridge â€” Stellar Account Check',
  checkedAccount: 'Checked account:',
  horizon: 'Horizon:',
  asset: 'Asset:',

  resultsHeading: 'Results',

  validationGateHeading: 'Validation gate',
  readyToProceed: 'Ready to proceed: all checks passed.',
  blockedBy: 'Blocked by:',
  passedChecks: 'Passed checks:',
  failedChecks: 'Failed checks:',

  balancesHeading: 'Balances',
  xlmBalance: 'XLM balance:',
  minimumRequired: 'Minimum required:',

  setupCostHeading: 'Setup cost estimate',
  minimumAccountBalance: 'Stellar minimum account balance:',
  baseReservePerTrustline: 'Base reserve per trustline (ledger entry):',
  typicalMinimumToFund: 'Typical minimum to fund account + one trustline:',

  addTrustlineHeading: 'Add a trustline',
  viewAccountOnLab: 'View account on Stellar Laboratory',
  openTransactionBuilder: 'Open Transaction Builder (Change Trust)',
  lobstrWallet: 'LOBSTR wallet',
  lobstrDescription: 'add asset',

  sepWalletActionsHeading: 'Quick wallet actions (SEP-0007)',
  sepWalletActionsDescription:
    'Open these links in a SEP-0007-compatible wallet (LOBSTR, Solar, Albedo) to complete setup.',
  sendXlmToActivate: 'Send {amount} XLM to activate account',

  remediationHeading: 'Remediation',

  configurationSummaryHeading: 'Configuration summary',
  inputColumn: 'Input',
  valueColumn: 'Value',
  failOnMissingTrue: '`true` â€” step fails on missing checks',
  failOnMissingFalse: '`false` â€” only warns',
  stickyCommentTrue: '`true` â€” upserts prior comment',
  stickyCommentFalse: '`false` â€” always posts new',
  waitUntilFundedTrue: '`true`',
  waitUntilFundedFalse: '`false` (default)',
  waitUntilFundedTimeoutMs: '`{ms}`',
  waitUntilFundedIntervalMs: '`{ms}`',

  outputsHeading: 'Action outputs reference',
  outputsDescription:
    'Use these output names in downstream workflow steps via `steps.<id>.outputs.<name>`.',
  outputColumn: 'Output',
  valueRunColumn: 'Value in this run',
  descriptionColumn: 'Description',
  accountFundedOutput: 'Whether the account exists on the Stellar network (from `action.yml`)',
  trustlineExistsOutput:
    'Whether the **{assetCode}** trustline is configured (from `action.yml`)',
  xlmBalanceOutput: 'Native XLM balance reported by Horizon (from `action.yml`)',
  commentUrlOutput: 'URL of this issue comment (from `action.yml`)',

  metricsHeading: 'Metrics',
  metricsDescription:
    'Machine-readable run metrics. Values are structural counts only â€” no account addresses or balances.',

  accountFundedLabel: 'Account funded',
  accountFundedPassDetail: (address: string) =>
    `Account ${address} is active on the Stellar network.`,
  accountFundedFailDetail: (address: string) =>
    `Account ${address} was **not found** on Horizon â€” it may not be funded or activated yet.`,
  trustlineLabel: (assetCode: string) => `${assetCode} trustline`,
  trustlinePassDetail: (assetCode: string, issuer: string) =>
    `Trustline for **${assetCode}** (${issuer}) is configured.`,
  trustlineFailHasTrustlines: (assetCode: string, issuer: string) =>
    `Account has trustlines, but not for **${assetCode}** issued by ${issuer}.`,
  trustlineFailNoTrustlines: 'Account has **zero trustlines** â€” add a trustline before receiving this asset.',
  xlmReserveLabel: 'XLM reserve',
  xlmReservePassDetail: (balance: string, required: string) =>
    `Balance **${balance} XLM** meets the minimum of **${required} XLM**.`,
  xlmReserveFailDetail: (balance: string, required: string) =>
    `Balance **${balance} XLM** is below the required **${required} XLM**.`,
  horizonAvailabilityLabel: 'Horizon availability',

  remediationAddTrustline: (assetCode: string) =>
    `Add a **${assetCode}** trustline using [Stellar Laboratory](https://laboratory.stellar.org/) (Change Trust operation) or a wallet such as [LOBSTR](https://lobstr.co/).`,
  remediationSendXlm: (amount: string, address: string) =>
    `Send at least **${amount} XLM** to ${address} to meet the reserve requirement.`,
  remediationActivateAccount: (address: string, minBalance: string, assetCode: string) =>
    `Activate ${address} by sending at least **${minBalance} XLM** (Stellar minimum account balance).\n\nThen add a **${assetCode}** trustline via [Stellar Laboratory](https://laboratory.stellar.org/) or [LOBSTR](https://lobstr.co/).`,
  remediationAccountNotFound: (assetCode: string) =>
    `Estimated setup cost: ~**1.5 XLM** (1 XLM base + 0.5 XLM per ${assetCode} trustline reserve).`,
  remediationEstimatedSetupCost: (cost: string) => `Estimated setup cost: ~**${cost} XLM**.`,
  remediationHorizonError:
    'Horizon could not be reached. Retry later or verify your `horizon_url` input and network connectivity.',
  networkMismatchDetected: 'Network mismatch detected.',
  networkMismatchConfiguredNetwork: 'Configured network:',
  networkMismatchActiveNetwork: 'Active network:',
  networkMismatchFix: 'Fund this address on the configured network.',
  networkMismatchUpdateUrl:
    'Update `horizon_url` to the active network URL if you intended to check that network.',
};

/**
 * Spanish (es) locale strings.
 */
const ES: CommentStrings = {
  heading: 'TrustBridge â€” VerificaciÃ³n de Cuenta Stellar',
  checkedAccount: 'Cuenta verificada:',
  horizon: 'Horizon:',
  asset: 'Activo:',

  resultsHeading: 'Resultados',

  validationGateHeading: 'Puerta de validaciÃ³n',
  readyToProceed: 'Listo para proceder: todas las comprobaciones pasaron.',
  blockedBy: 'Bloqueado por:',
  passedChecks: 'Comprobaciones pasadas:',
  failedChecks: 'Comprobaciones fallidas:',

  balancesHeading: 'Saldos',
  xlmBalance: 'Saldo de XLM:',
  minimumRequired: 'MÃ­nimo requerido:',

  setupCostHeading: 'EstimaciÃ³n del costo de configuraciÃ³n',
  minimumAccountBalance: 'Saldo mÃ­nimo de cuenta Stellar:',
  baseReservePerTrustline: 'Reserva base por lÃ­nea de confianza (entrada del libro mayor):',
  typicalMinimumToFund: 'MÃ­nimo tÃ­pico para financiar cuenta + una lÃ­nea de confianza:',

  addTrustlineHeading: 'Agregar una lÃ­nea de confianza',
  viewAccountOnLab: 'Ver cuenta en Stellar Laboratory',
  openTransactionBuilder: 'Abrir Transaction Builder (Change Trust)',
  lobstrWallet: 'Billetera LOBSTR',
  lobstrDescription: 'agregar activo',

  sepWalletActionsHeading: 'Acciones rÃ¡pidas de billetera (SEP-0007)',
  sepWalletActionsDescription:
    'Abre estos enlaces en una billetera compatible con SEP-0007 (LOBSTR, Solar, Albedo) para completar la configuraciÃ³n.',
  sendXlmToActivate: 'EnvÃ­a {amount} XLM para activar la cuenta',

  remediationHeading: 'RemediaciÃ³n',

  configurationSummaryHeading: 'Resumen de configuraciÃ³n',
  inputColumn: 'Entrada',
  valueColumn: 'Valor',
  failOnMissingTrue: '`true` â€” el paso falla en comprobaciones faltantes',
  failOnMissingFalse: '`false` â€” solo advierte',
  stickyCommentTrue: '`true` â€” actualiza comentario anterior',
  stickyCommentFalse: '`false` â€” siempre publica uno nuevo',
  waitUntilFundedTrue: '`true`',
  waitUntilFundedFalse: '`false` (predeterminado)',
  waitUntilFundedTimeoutMs: '`{ms}`',
  waitUntilFundedIntervalMs: '`{ms}`',

  outputsHeading: 'Referencia de salidas de acciÃ³n',
  outputsDescription:
    'Use estos nombres de salida en pasos de flujo de trabajo posteriores a travÃ©s de `steps.<id>.outputs.<name>`.',
  outputColumn: 'Salida',
  valueRunColumn: 'Valor en esta ejecuciÃ³n',
  descriptionColumn: 'DescripciÃ³n',
  accountFundedOutput: 'Si la cuenta existe en la red Stellar (de `action.yml`)',
  trustlineExistsOutput:
    'Si la lÃ­nea de confianza **{assetCode}** estÃ¡ configurada (de `action.yml`)',
  xlmBalanceOutput: 'Saldo de XLM nativo reportado por Horizon (de `action.yml`)',
  commentUrlOutput: 'URL del comentario de problema (de `action.yml`)',

  metricsHeading: 'MÃ©tricas',
  metricsDescription:
    'MÃ©tricas de ejecuciÃ³n legibles por mÃ¡quina. Los valores son solo recuentos estructurales â€” sin direcciones de cuenta ni saldos.',

  accountFundedLabel: 'Cuenta financiada',
  accountFundedPassDetail: (address: string) =>
    `La cuenta ${address} estÃ¡ activa en la red Stellar.`,
  accountFundedFailDetail: (address: string) =>
    `La cuenta ${address} **no se encontrÃ³** en Horizon â€” puede que no estÃ© financiada o activada aÃºn.`,
  trustlineLabel: (assetCode: string) => `LÃ­nea de confianza ${assetCode}`,
  trustlinePassDetail: (assetCode: string, issuer: string) =>
    `LÃ­nea de confianza para **${assetCode}** (${issuer}) estÃ¡ configurada.`,
  trustlineFailHasTrustlines: (assetCode: string, issuer: string) =>
    `La cuenta tiene lÃ­neas de confianza, pero no para **${assetCode}** emitido por ${issuer}.`,
  trustlineFailNoTrustlines: 'La cuenta tiene **cero lÃ­neas de confianza** â€” agrega una antes de recibir este activo.',
  xlmReserveLabel: 'Reserva de XLM',
  xlmReservePassDetail: (balance: string, required: string) =>
    `El saldo **${balance} XLM** cumple con el mÃ­nimo de **${required} XLM**.`,
  xlmReserveFailDetail: (balance: string, required: string) =>
    `El saldo **${balance} XLM** estÃ¡ por debajo del requerido **${required} XLM**.`,
  horizonAvailabilityLabel: 'Disponibilidad de Horizon',

  remediationAddTrustline: (assetCode: string) =>
    `Agrega una lÃ­nea de confianza **${assetCode}** usando [Stellar Laboratory](https://laboratory.stellar.org/) (operaciÃ³n Change Trust) o una billetera como [LOBSTR](https://lobstr.co/).`,
  remediationSendXlm: (amount: string, address: string) =>
    `EnvÃ­a al menos **${amount} XLM** a ${address} para cumplir con el requisito de reserva.`,
  remediationActivateAccount: (address: string, minBalance: string, assetCode: string) =>
    `Activa ${address} enviando al menos **${minBalance} XLM** (saldo mÃ­nimo de cuenta Stellar).\n\nLuego agrega una lÃ­nea de confianza **${assetCode}** a travÃ©s de [Stellar Laboratory](https://laboratory.stellar.org/) o [LOBSTR](https://lobstr.co/).`,
  remediationAccountNotFound: (assetCode: string) =>
    `Costo estimado de configuraciÃ³n: ~**1.5 XLM** (1 XLM base + 0.5 XLM por reserva de lÃ­nea de confianza ${assetCode}).`,
  remediationEstimatedSetupCost: (cost: string) => `Costo estimado de configuraciÃ³n: ~**${cost} XLM**.`,
  remediationHorizonError:
    'Horizon no se pudo alcanzar. ReintÃ©ntalo mÃ¡s tarde o verifica tu entrada `horizon_url` y la conectividad de red.',
  networkMismatchDetected: 'Se detectÃ³ una discrepancia de red.',
  networkMismatchConfiguredNetwork: 'Red configurada:',
  networkMismatchActiveNetwork: 'Red activa:',
  networkMismatchFix: 'Financia esta cuenta en la red configurada.',
  networkMismatchUpdateUrl:
    'Actualiza `horizon_url` a la URL de la red activa si querÃ­as comprobar esa red.',
};

/**
 * Portuguese (pt) locale strings.
 */
const PT: CommentStrings = {
  heading: 'TrustBridge â€” VerificaÃ§Ã£o de Conta Stellar',
  checkedAccount: 'Conta verificada:',
  horizon: 'Horizon:',
  asset: 'Ativo:',

  resultsHeading: 'Resultados',

  validationGateHeading: 'PortÃ£o de validaÃ§Ã£o',
  readyToProceed: 'Pronto para prosseguir: todas as verificaÃ§Ãµes passaram.',
  blockedBy: 'Bloqueado por:',
  passedChecks: 'VerificaÃ§Ãµes aprovadas:',
  failedChecks: 'VerificaÃ§Ãµes falhadas:',

  balancesHeading: 'Saldos',
  xlmBalance: 'Saldo de XLM:',
  minimumRequired: 'MÃ­nimo necessÃ¡rio:',

  setupCostHeading: 'Estimativa de custo de configuraÃ§Ã£o',
  minimumAccountBalance: 'Saldo mÃ­nimo de conta Stellar:',
  baseReservePerTrustline: 'Reserva base por linha de confianÃ§a (entrada de ledger):',
  typicalMinimumToFund: 'MÃ­nimo tÃ­pico para financiar conta + uma linha de confianÃ§a:',

  addTrustlineHeading: 'Adicionar uma linha de confianÃ§a',
  viewAccountOnLab: 'Ver conta no Stellar Laboratory',
  openTransactionBuilder: 'Abrir Transaction Builder (Change Trust)',
  lobstrWallet: 'Carteira LOBSTR',
  lobstrDescription: 'adicionar ativo',

  sepWalletActionsHeading: 'AÃ§Ãµes rÃ¡pidas da carteira (SEP-0007)',
  sepWalletActionsDescription:
    'Abra esses links em uma carteira compatÃ­vel com SEP-0007 (LOBSTR, Solar, Albedo) para concluir a configuraÃ§Ã£o.',
  sendXlmToActivate: 'Envie {amount} XLM para ativar a conta',

  remediationHeading: 'RemediaÃ§Ã£o',

  configurationSummaryHeading: 'Resumo da configuraÃ§Ã£o',
  inputColumn: 'Entrada',
  valueColumn: 'Valor',
  failOnMissingTrue: '`true` â€” etapa falha em verificaÃ§Ãµes ausentes',
  failOnMissingFalse: '`false` â€” apenas avisa',
  stickyCommentTrue: '`true` â€” atualiza comentÃ¡rio anterior',
  stickyCommentFalse: '`false` â€” sempre publica um novo',
  waitUntilFundedTrue: '`true`',
  waitUntilFundedFalse: '`false` (padrÃ£o)',
  waitUntilFundedTimeoutMs: '`{ms}`',
  waitUntilFundedIntervalMs: '`{ms}`',

  outputsHeading: 'ReferÃªncia de saÃ­das de aÃ§Ã£o',
  outputsDescription:
    'Use esses nomes de saÃ­da em etapas de fluxo de trabalho posteriores via `steps.<id>.outputs.<name>`.',
  outputColumn: 'SaÃ­da',
  valueRunColumn: 'Valor nesta execuÃ§Ã£o',
  descriptionColumn: 'DescriÃ§Ã£o',
  accountFundedOutput: 'Se a conta existe na rede Stellar (de `action.yml`)',
  trustlineExistsOutput:
    'Se a linha de confianÃ§a **{assetCode}** estÃ¡ configurada (de `action.yml`)',
  xlmBalanceOutput: 'Saldo de XLM nativo relatado pelo Horizon (de `action.yml`)',
  commentUrlOutput: 'URL do comentÃ¡rio de problema (de `action.yml`)',

  metricsHeading: 'MÃ©tricas',
  metricsDescription:
    'MÃ©tricas de execuÃ§Ã£o legÃ­veis por mÃ¡quina. Os valores sÃ£o apenas contagens estruturais â€” nenhum endereÃ§o de conta ou saldo.',

  accountFundedLabel: 'Conta financiada',
  accountFundedPassDetail: (address: string) =>
    `A conta ${address} estÃ¡ ativa na rede Stellar.`,
  accountFundedFailDetail: (address: string) =>
    `A conta ${address} **nÃ£o foi encontrada** no Horizon â€” pode nÃ£o estar financiada ou ativada ainda.`,
  trustlineLabel: (assetCode: string) => `Linha de confianÃ§a ${assetCode}`,
  trustlinePassDetail: (assetCode: string, issuer: string) =>
    `Linha de confianÃ§a para **${assetCode}** (${issuer}) estÃ¡ configurada.`,
  trustlineFailHasTrustlines: (assetCode: string, issuer: string) =>
    `A conta tem linhas de confianÃ§a, mas nÃ£o para **${assetCode}** emitido por ${issuer}.`,
  trustlineFailNoTrustlines: 'A conta tem **zero linhas de confianÃ§a** â€” adicione uma antes de receber esse ativo.',
  xlmReserveLabel: 'Reserva de XLM',
  xlmReservePassDetail: (balance: string, required: string) =>
    `Saldo **${balance} XLM** atende ao mÃ­nimo de **${required} XLM**.`,
  xlmReserveFailDetail: (balance: string, required: string) =>
    `Saldo **${balance} XLM** estÃ¡ abaixo do exigido **${required} XLM**.`,
  horizonAvailabilityLabel: 'Disponibilidade do Horizon',

  remediationAddTrustline: (assetCode: string) =>
    `Adicione uma linha de confianÃ§a **${assetCode}** usando [Stellar Laboratory](https://laboratory.stellar.org/) (operaÃ§Ã£o Change Trust) ou uma carteira como [LOBSTR](https://lobstr.co/).`,
  remediationSendXlm: (amount: string, address: string) =>
    `Envie pelo menos **${amount} XLM** para ${address} para atender ao requisito de reserva.`,
  remediationActivateAccount: (address: string, minBalance: string, assetCode: string) =>
    `Ative ${address} enviando pelo menos **${minBalance} XLM** (saldo mÃ­nimo de conta Stellar).\n\nEm seguida, adicione uma linha de confianÃ§a **${assetCode}** via [Stellar Laboratory](https://laboratory.stellar.org/) ou [LOBSTR](https://lobstr.co/).`,
  remediationAccountNotFound: (assetCode: string) =>
    `Custo estimado de configuraÃ§Ã£o: ~**1.5 XLM** (1 XLM base + 0.5 XLM por reserva de linha de confianÃ§a ${assetCode}).`,
  remediationEstimatedSetupCost: (cost: string) => `Custo estimado de configuraÃ§Ã£o: ~**${cost} XLM**.`,
  remediationHorizonError:
    'Horizon nÃ£o pÃ´de ser alcanÃ§ado. Tente novamente mais tarde ou verifique sua entrada `horizon_url` e a conectividade de rede.',
  networkMismatchDetected: 'DiscrepÃ¢ncia de rede detectada.',
  networkMismatchConfiguredNetwork: 'Rede configurada:',
  networkMismatchActiveNetwork: 'Rede ativa:',
  networkMismatchFix: 'Financie esta conta na rede configurada.',
  networkMismatchUpdateUrl:
    'Atualize `horizon_url` para a URL da rede ativa se vocÃª pretendia verificar essa rede.',
};

/**
 * Japanese (ja) locale strings.
 *
 * CJK note: Japanese characters are full-width (2 columns each in terminal
 * renderers), but GitHub Markdown tables render in proportional HTML — no
 * manual padding is required. Strings are kept concise to avoid table
 * overflow in narrow viewports.
 */
const JA: CommentStrings = {
  heading: 'TrustBridge — Stellarアカウントチェック',
  checkedAccount: '確認済みアカウント:',
  horizon: 'Horizon:',
  asset: 'アセット:',

  resultsHeading: '結果',

  validationGateHeading: 'バリデーションゲート',
  readyToProceed: '続行可能: すべてのチェックに合格しました。',
  blockedBy: 'ブロック理由:',
  passedChecks: '合格したチェック:',
  failedChecks: '不合格のチェック:',

  balancesHeading: '残高',
  xlmBalance: 'XLM残高:',
  minimumRequired: '最低必要額:',

  setupCostHeading: '初期費用の見積もり',
  minimumAccountBalance: 'Stellarアカウントの最低残高:',
  baseReservePerTrustline: 'トラストライン1件あたりの基本準備金 (台帳エントリ):',
  typicalMinimumToFund: 'アカウント開設+トラストライン1件に必要な最低限度:',

  addTrustlineHeading: 'トラストラインの追加',
  viewAccountOnLab: 'Stellar Laboratoryでアカウントを表示',
  openTransactionBuilder: 'Transaction Builderを開く (Change Trust)',
  lobstrWallet: 'LOBSTRウォレット',
  lobstrDescription: 'アセットを追加',

  sepWalletActionsHeading: 'クイックウォレット操作 (SEP-0007)',
  sepWalletActionsDescription:
    'SEP-0007対応ウォレット (LOBSTR、Solar、Albedo) でこれらのリンクを開いてセットアップを完了してください。',
  sendXlmToActivate: '{amount} XLMを送信してアカウントを有効化',

  remediationHeading: '対処方法',

  configurationSummaryHeading: '設定サマリー',
  inputColumn: '入力',
  valueColumn: '値',
  failOnMissingTrue: '`true` — チェック未通過時にステップが失敗',
  failOnMissingFalse: '`false` — 警告のみ',
  stickyCommentTrue: '`true` — 以前のコメントを更新',
  stickyCommentFalse: '`false` — 常に新規投稿',
  waitUntilFundedTrue: '`true`',
  waitUntilFundedFalse: '`false` (デフォルト)',
  waitUntilFundedTimeoutMs: '`{ms}`',
  waitUntilFundedIntervalMs: '`{ms}`',

  outputsHeading: 'アクション出力リファレンス',
  outputsDescription:
    '`steps.<id>.outputs.<name>` を使って後続のワークフローステップでこれらの出力名を参照してください。',
  outputColumn: '出力',
  valueRunColumn: '今回の実行値',
  descriptionColumn: '説明',
  accountFundedOutput: 'アカウントがStellarネットワーク上に存在するか (`action.yml` より)',
  trustlineExistsOutput:
    '**{assetCode}** トラストラインが設定されているか (`action.yml` より)',
  xlmBalanceOutput: 'Horizonが報告するネイティブXLM残高 (`action.yml` より)',
  commentUrlOutput: 'このIssueコメントのURL (`action.yml` より)',

  metricsHeading: 'メトリクス',
  metricsDescription:
    'マシンリーダブルな実行メトリクス。値は構造的なカウントのみです — アカウントアドレスや残高は含まれません。',

  accountFundedLabel: 'アカウント資金化',
  accountFundedPassDetail: (address: string) =>
    `アカウント ${address} はStellarネットワーク上でアクティブです。`,
  accountFundedFailDetail: (address: string) =>
    `アカウント ${address} はHorizonで**見つかりませんでした** — まだ資金化または有効化されていない可能性があります。`,
  trustlineLabel: (assetCode: string) => `${assetCode} トラストライン`,
  trustlinePassDetail: (assetCode: string, issuer: string) =>
    `**${assetCode}** (${issuer}) のトラストラインが設定されています。`,
  trustlineFailHasTrustlines: (assetCode: string, issuer: string) =>
    `アカウントにはトラストラインがありますが、${issuer} が発行した **${assetCode}** のものではありません。`,
  trustlineFailNoTrustlines: 'アカウントには**トラストラインがゼロ件**です — このアセットを受け取る前にトラストラインを追加してください。',
  xlmReserveLabel: 'XLM準備金',
  xlmReservePassDetail: (balance: string, required: string) =>
    `残高 **${balance} XLM** は最低 **${required} XLM** の要件を満たしています。`,
  xlmReserveFailDetail: (balance: string, required: string) =>
    `残高 **${balance} XLM** は必要な **${required} XLM** を下回っています。`,
  horizonAvailabilityLabel: 'Horizon可用性',

  remediationAddTrustline: (assetCode: string) =>
    `[Stellar Laboratory](https://laboratory.stellar.org/) (Change Trust操作) または [LOBSTR](https://lobstr.co/) などのウォレットを使用して **${assetCode}** トラストラインを追加してください。`,
  remediationSendXlm: (amount: string, address: string) =>
    `準備金要件を満たすために、${address} に少なくとも **${amount} XLM** を送信してください。`,
  remediationActivateAccount: (address: string, minBalance: string, assetCode: string) =>
    `${address} を有効化するには、少なくとも **${minBalance} XLM** (Stellarアカウント最低残高) を送信してください。\n\n次に [Stellar Laboratory](https://laboratory.stellar.org/) または [LOBSTR](https://lobstr.co/) で **${assetCode}** トラストラインを追加してください。`,
  remediationAccountNotFound: (assetCode: string) =>
    `初期費用の見積もり: 約**1.5 XLM** (1 XLM基本 + ${assetCode}トラストライン準備金0.5 XLM)。`,
  remediationEstimatedSetupCost: (cost: string) => `初期費用の見積もり: 約**${cost} XLM**。`,
  remediationHorizonError:
    'Horizonに接続できませんでした。後でもう一度お試しいただくか、`horizon_url` の入力とネットワーク接続を確認してください。',
};

/**
 * French (fr) locale strings.
 */
const FR: CommentStrings = {
  heading: 'TrustBridge — Vérification du Compte Stellar',
  checkedAccount: 'Compte vérifié :',
  horizon: 'Horizon :',
  asset: 'Actif :',

  resultsHeading: 'Résultats',

  validationGateHeading: 'Portail de validation',
  readyToProceed: 'Prêt à continuer : toutes les vérifications ont réussi.',
  blockedBy: 'Bloqué par :',
  passedChecks: 'Vérifications réussies :',
  failedChecks: 'Vérifications échouées :',

  balancesHeading: 'Soldes',
  xlmBalance: 'Solde XLM :',
  minimumRequired: 'Minimum requis :',

  setupCostHeading: 'Estimation du coût de configuration',
  minimumAccountBalance: 'Solde minimum de compte Stellar :',
  baseReservePerTrustline: 'Réserve de base par ligne de confiance (entrée de registre) :',
  typicalMinimumToFund: 'Minimum typique pour financer un compte + une ligne de confiance :',

  addTrustlineHeading: 'Ajouter une ligne de confiance',
  viewAccountOnLab: 'Voir le compte sur Stellar Laboratory',
  openTransactionBuilder: 'Ouvrir Transaction Builder (Change Trust)',
  lobstrWallet: 'Portefeuille LOBSTR',
  lobstrDescription: 'ajouter un actif',

  sepWalletActionsHeading: 'Actions rapides du portefeuille (SEP-0007)',
  sepWalletActionsDescription:
    'Ouvrez ces liens dans un portefeuille compatible SEP-0007 (LOBSTR, Solar, Albedo) pour finaliser la configuration.',
  sendXlmToActivate: 'Envoyer {amount} XLM pour activer le compte',

  remediationHeading: 'Remédiation',

  configurationSummaryHeading: 'Résumé de la configuration',
  inputColumn: 'Entrée',
  valueColumn: 'Valeur',
  failOnMissingTrue: '`true` — l\'étape échoue en cas de vérifications manquantes',
  failOnMissingFalse: '`false` — avertissement seulement',
  stickyCommentTrue: '`true` — met à jour le commentaire précédent',
  stickyCommentFalse: '`false` — publie toujours un nouveau',
  waitUntilFundedTrue: '`true`',
  waitUntilFundedFalse: '`false` (défaut)',
  waitUntilFundedTimeoutMs: '`{ms}`',
  waitUntilFundedIntervalMs: '`{ms}`',

  outputsHeading: 'Référence des sorties de l\'action',
  outputsDescription:
    'Utilisez ces noms de sortie dans les étapes de workflow suivantes via `steps.<id>.outputs.<name>`.',
  outputColumn: 'Sortie',
  valueRunColumn: 'Valeur dans cette exécution',
  descriptionColumn: 'Description',
  accountFundedOutput: 'Si le compte existe sur le réseau Stellar (depuis `action.yml`)',
  trustlineExistsOutput:
    'Si la ligne de confiance **{assetCode}** est configurée (depuis `action.yml`)',
  xlmBalanceOutput: 'Solde XLM natif rapporté par Horizon (depuis `action.yml`)',
  commentUrlOutput: 'URL du commentaire d\'issue (depuis `action.yml`)',

  metricsHeading: 'Métriques',
  metricsDescription:
    'Métriques d\'exécution lisibles par machine. Les valeurs sont uniquement des comptages structurels — aucune adresse de compte ni solde.',

  accountFundedLabel: 'Compte financé',
  accountFundedPassDetail: (address: string) =>
    `Le compte ${address} est actif sur le réseau Stellar.`,
  accountFundedFailDetail: (address: string) =>
    `Le compte ${address} n'a **pas été trouvé** sur Horizon — il n'est peut-être pas encore financé ou activé.`,
  trustlineLabel: (assetCode: string) => `Ligne de confiance ${assetCode}`,
  trustlinePassDetail: (assetCode: string, issuer: string) =>
    `La ligne de confiance pour **${assetCode}** (${issuer}) est configurée.`,
  trustlineFailHasTrustlines: (assetCode: string, issuer: string) =>
    `Le compte a des lignes de confiance, mais pas pour **${assetCode}** émis par ${issuer}.`,
  trustlineFailNoTrustlines: 'Le compte a **zéro ligne de confiance** — ajoutez-en une avant de recevoir cet actif.',
  xlmReserveLabel: 'Réserve XLM',
  xlmReservePassDetail: (balance: string, required: string) =>
    `Le solde **${balance} XLM** satisfait le minimum de **${required} XLM**.`,
  xlmReserveFailDetail: (balance: string, required: string) =>
    `Le solde **${balance} XLM** est en dessous du requis **${required} XLM**.`,
  horizonAvailabilityLabel: 'Disponibilité Horizon',

  remediationAddTrustline: (assetCode: string) =>
    `Ajoutez une ligne de confiance **${assetCode}** via [Stellar Laboratory](https://laboratory.stellar.org/) (opération Change Trust) ou un portefeuille tel que [LOBSTR](https://lobstr.co/).`,
  remediationSendXlm: (amount: string, address: string) =>
    `Envoyez au moins **${amount} XLM** à ${address} pour satisfaire l'exigence de réserve.`,
  remediationActivateAccount: (address: string, minBalance: string, assetCode: string) =>
    `Activez ${address} en envoyant au moins **${minBalance} XLM** (solde minimum de compte Stellar).\n\nEnsuite, ajoutez une ligne de confiance **${assetCode}** via [Stellar Laboratory](https://laboratory.stellar.org/) ou [LOBSTR](https://lobstr.co/).`,
  remediationAccountNotFound: (assetCode: string) =>
    `Coût de configuration estimé : ~**1.5 XLM** (1 XLM de base + 0.5 XLM de réserve pour la ligne de confiance ${assetCode}).`,
  remediationEstimatedSetupCost: (cost: string) => `Coût de configuration estimé : ~**${cost} XLM**.`,
  remediationHorizonError:
    'Horizon n\'a pas pu être atteint. Réessayez plus tard ou vérifiez votre entrée `horizon_url` et la connectivité réseau.',
};

/**
 * German (de) locale strings.
 */
const DE: CommentStrings = {
  heading: 'TrustBridge — Stellar-Kontoprüfung',
  checkedAccount: 'Geprüftes Konto:',
  horizon: 'Horizon:',
  asset: 'Asset:',

  resultsHeading: 'Ergebnisse',

  validationGateHeading: 'Validierungsschranke',
  readyToProceed: 'Bereit fortzufahren: alle Prüfungen bestanden.',
  blockedBy: 'Blockiert durch:',
  passedChecks: 'Bestandene Prüfungen:',
  failedChecks: 'Fehlgeschlagene Prüfungen:',

  balancesHeading: 'Guthaben',
  xlmBalance: 'XLM-Guthaben:',
  minimumRequired: 'Mindestbetrag:',

  setupCostHeading: 'Schätzung der Einrichtungskosten',
  minimumAccountBalance: 'Stellar-Mindestkontoguthaben:',
  baseReservePerTrustline: 'Basisreserve pro Trustline (Ledger-Eintrag):',
  typicalMinimumToFund: 'Typisches Minimum für Konto + eine Trustline:',

  addTrustlineHeading: 'Trustline hinzufügen',
  viewAccountOnLab: 'Konto im Stellar Laboratory anzeigen',
  openTransactionBuilder: 'Transaction Builder öffnen (Change Trust)',
  lobstrWallet: 'LOBSTR-Wallet',
  lobstrDescription: 'Asset hinzufügen',

  sepWalletActionsHeading: 'Schnelle Wallet-Aktionen (SEP-0007)',
  sepWalletActionsDescription:
    'Öffnen Sie diese Links in einem SEP-0007-kompatiblen Wallet (LOBSTR, Solar, Albedo), um die Einrichtung abzuschließen.',
  sendXlmToActivate: '{amount} XLM senden, um das Konto zu aktivieren',

  remediationHeading: 'Behebung',

  configurationSummaryHeading: 'Konfigurationszusammenfassung',
  inputColumn: 'Eingabe',
  valueColumn: 'Wert',
  failOnMissingTrue: '`true` — Schritt schlägt bei fehlenden Prüfungen fehl',
  failOnMissingFalse: '`false` — nur Warnung',
  stickyCommentTrue: '`true` — aktualisiert vorherigen Kommentar',
  stickyCommentFalse: '`false` — veröffentlicht immer neu',
  waitUntilFundedTrue: '`true`',
  waitUntilFundedFalse: '`false` (Standard)',
  waitUntilFundedTimeoutMs: '`{ms}`',
  waitUntilFundedIntervalMs: '`{ms}`',

  outputsHeading: 'Referenz der Action-Ausgaben',
  outputsDescription:
    'Verwenden Sie diese Ausgabenamen in nachgelagerten Workflow-Schritten über `steps.<id>.outputs.<name>`.',
  outputColumn: 'Ausgabe',
  valueRunColumn: 'Wert in diesem Lauf',
  descriptionColumn: 'Beschreibung',
  accountFundedOutput: 'Ob das Konto im Stellar-Netzwerk existiert (aus `action.yml`)',
  trustlineExistsOutput:
    'Ob die **{assetCode}**-Trustline konfiguriert ist (aus `action.yml`)',
  xlmBalanceOutput: 'Natives XLM-Guthaben laut Horizon (aus `action.yml`)',
  commentUrlOutput: 'URL des Issue-Kommentars (aus `action.yml`)',

  metricsHeading: 'Metriken',
  metricsDescription:
    'Maschinenlesbare Laufmetriken. Werte sind nur strukturelle Zählungen — keine Kontoadressen oder Guthaben.',

  accountFundedLabel: 'Konto finanziert',
  accountFundedPassDetail: (address: string) =>
    `Konto ${address} ist im Stellar-Netzwerk aktiv.`,
  accountFundedFailDetail: (address: string) =>
    `Konto ${address} wurde bei Horizon **nicht gefunden** — es ist möglicherweise noch nicht finanziert oder aktiviert.`,
  trustlineLabel: (assetCode: string) => `${assetCode}-Trustline`,
  trustlinePassDetail: (assetCode: string, issuer: string) =>
    `Trustline für **${assetCode}** (${issuer}) ist konfiguriert.`,
  trustlineFailHasTrustlines: (assetCode: string, issuer: string) =>
    `Das Konto hat Trustlines, jedoch nicht für **${assetCode}** von ${issuer}.`,
  trustlineFailNoTrustlines: 'Das Konto hat **null Trustlines** — fügen Sie eine hinzu, bevor Sie dieses Asset empfangen.',
  xlmReserveLabel: 'XLM-Reserve',
  xlmReservePassDetail: (balance: string, required: string) =>
    `Guthaben **${balance} XLM** erfüllt das Minimum von **${required} XLM**.`,
  xlmReserveFailDetail: (balance: string, required: string) =>
    `Guthaben **${balance} XLM** liegt unter dem erforderlichen **${required} XLM**.`,
  horizonAvailabilityLabel: 'Horizon-Verfügbarkeit',

  remediationAddTrustline: (assetCode: string) =>
    `Fügen Sie eine **${assetCode}**-Trustline über [Stellar Laboratory](https://laboratory.stellar.org/) (Change-Trust-Operation) oder ein Wallet wie [LOBSTR](https://lobstr.co/) hinzu.`,
  remediationSendXlm: (amount: string, address: string) =>
    `Senden Sie mindestens **${amount} XLM** an ${address}, um die Reserveanforderung zu erfüllen.`,
  remediationActivateAccount: (address: string, minBalance: string, assetCode: string) =>
    `Aktivieren Sie ${address}, indem Sie mindestens **${minBalance} XLM** (Stellar-Mindestkontoguthaben) senden.\n\nFügen Sie dann eine **${assetCode}**-Trustline über [Stellar Laboratory](https://laboratory.stellar.org/) oder [LOBSTR](https://lobstr.co/) hinzu.`,
  remediationAccountNotFound: (assetCode: string) =>
    `Geschätzte Einrichtungskosten: ~**1,5 XLM** (1 XLM Basis + 0,5 XLM ${assetCode}-Trustline-Reserve).`,
  remediationEstimatedSetupCost: (cost: string) => `Geschätzte Einrichtungskosten: ~**${cost} XLM**.`,
  remediationHorizonError:
    'Horizon konnte nicht erreicht werden. Versuchen Sie es später erneut oder überprüfen Sie Ihre `horizon_url`-Eingabe und die Netzwerkkonnektivität.',
};

const LOCALES: Record<Locale, CommentStrings> = {
  en: EN,
  es: ES,
  pt: PT,
  ja: JA,
  fr: FR,
  de: DE,
};

/**
 * Get comment strings for a given locale, with automatic fallback to English
 * if the locale is not available.
 */
export function getStrings(locale: Locale | string): CommentStrings {
  const normalizedLocale = (locale || 'en').toLowerCase();
  return LOCALES[normalizedLocale as Locale] || EN;
}

/**
 * Validate that a locale string is supported.
 */
export function isValidLocale(locale: string | null | undefined): boolean {
  if (!locale) return false;
  return Object.keys(LOCALES).includes(locale.toLowerCase());
}

/**
 * Parse and validate a locale input from action configuration.
 * Falls back to 'en' if the input is invalid or unset.
 */
export function parseLocaleInput(input: string | undefined): Locale {
  if (!input) return 'en';
  const normalized = input.trim().toLowerCase();
  if (isValidLocale(normalized)) {
    return normalized as Locale;
  }
  return 'en';
}
