/**
 * Internationalization (i18n) template layer for TrustBridge issue comments.
 *
 * Provides locale-aware comment templates with fallback to English.
 * Strings that appear in Markdown issue comments are externalized here,
 * making it easy for consumers to add new locales or adjust copy.
 */

export type Locale = 'en' | 'es' | 'pt';

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

const LOCALES: Record<Locale, CommentStrings> = {
  en: EN,
  es: ES,
  pt: PT,
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
