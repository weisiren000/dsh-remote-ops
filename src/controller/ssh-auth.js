const AUTH_METHODS = ['password', 'keyboard-interactive']
const PASSWORD_PROMPTS = [
  /^(?:(?:please\s+)?(?:enter|input)\s+)?(?:your\s+)?(?:login\s+)?(?:password|passwd)\s*[:：]?\s*$/i,
  /^(?:password|passwd)\s+for\s+[\w.@\\/#-]+\s*[:：]?\s*$/i,
  /^.+['’]s\s+password\s*[:：]\s*$/i,
  /^(?:请输入|请填写)?(?:登录)?(?:密码|口令)\s*[:：]?\s*$/i,
]
const SECOND_FACTOR_CONTEXT = /\b(?:otp|totp|mfa|2fa|duo|pin|passcode|sms|token|fido|webauthn)\b|one[ -]?time|verification[ -]?code|recovery[ -]?code|backup[ -]?code|authenticator|security[ -]?(?:code|key)|hardware[ -]?key|challenge[ -]?response|(?:two|second|secondary|additional(?: authentication)?|multi)[ -]?factor|push[ -]?notification|approv(?:e|al)|confirm(?:ation)?|短信|验证码|动态码|一次性|双因素|双重认证|两步验证|多因素|令牌|二次确认|确认登录|推送|批准|认证器|安全码/i
const ACCOUNT_PASSWORD_PROMPT = /^[\w.@\\/#-]+['’]s\s+password\s*[:：]?\s*$/i

function unsupportedInteractiveError() {
  const error = new Error('服务器要求 OTP、MFA、验证码或其他无法安全自动处理的交互式认证，未提交登录密码')
  error.code = 'SSH_INTERACTIVE_AUTH_UNSUPPORTED'
  return error
}

function noAuthMethodsError() {
  const error = new Error('服务器无可用 SSH 认证方式')
  error.code = 'SSH_NO_AUTH_METHODS'
  return error
}

function isPasswordChallenge(name, instructions, prompts, alreadyAnswered) {
  if (alreadyAnswered || !Array.isArray(prompts) || prompts.length !== 1) return false
  const [challenge] = prompts
  const prompt = challenge?.prompt ?? ''
  if (challenge?.echo !== false || !PASSWORD_PROMPTS.some((pattern) => pattern.test(prompt))) return false
  if (/['’]s\s+password/i.test(prompt) && !ACCOUNT_PASSWORD_PROMPT.test(prompt)) return false
  const context = [name, instructions, challenge.prompt].filter(Boolean).join('\n')
  return !SECOND_FACTOR_CONTEXT.test(context)
}

// 密码仅保留到首次认证完成；未知或多因素挑战一律不作答。
export function createKeyboardInteractiveAuth(loginPassword, reject) {
  let password = loginPassword
  let answered = false
  let sentNone = false
  let currentMethod
  const attemptedMethods = new Set()
  const rejectUnsupported = () => {
    reject(unsupportedInteractiveError())
    return false
  }
  return {
    authHandler(methodsLeft, partialSuccess) {
      if (partialSuccess) return rejectUnsupported()
      if (!sentNone) {
        sentNone = true
        currentMethod = 'none'
        return currentMethod
      }
      currentMethod = AUTH_METHODS.find((method) => (
        methodsLeft?.includes(method) && !attemptedMethods.has(method)
      ))
      if (!currentMethod && attemptedMethods.size === 0) {
        reject(noAuthMethodsError())
        return false
      }
      if (!currentMethod) return false
      attemptedMethods.add(currentMethod)
      return currentMethod
    },
    clear() {
      password = undefined
    },
    handle(name, instructions, _language, prompts, finish) {
      if (!password || !isPasswordChallenge(name, instructions, prompts, answered)) {
        reject(unsupportedInteractiveError())
        return
      }
      answered = true
      finish([password])
    },
    readyError() {
      if (currentMethod === 'keyboard-interactive' && !answered) {
        return unsupportedInteractiveError()
      }
      return undefined
    },
  }
}
