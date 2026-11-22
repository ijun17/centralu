/**
 * Real answers of Cursor's dashboard service to the person's token (agent 2026.10.22-27dcf5f signed in, Windows, Free plan,
 * 2026-11-22), as Connect JSON. They hold no account id; nothing was replaced. Same minute: a prompt was refused "You've
 * hit your usage limit", so 0% here is of a limit of 0, not of an allowance left
 */
export const PERIOD_FREE_RECORDED = `{"billingCycleStart":"1792843958574","billingCycleEnd":"1795522358574","planUsage":{"remainingBonus":false,"bonusTooltip":"We work with model providers to give you free usage beyond what you've purchased. Amounts may vary.","autoPercentUsed":0,"apiPercentUsed":0,"totalPercentUsed":0},"spendLimitUsage":{"pooledLimit":"0","pooledRemaining":"0","individualLimit":0,"limitType":"user","overallLimit":0,"overallRemaining":0},"displayThreshold":200,"displayMessage":"You've used 0% of your included usage","autoModelSelectedDisplayMessage":"You've used 0% of your included total usage","namedModelSelectedDisplayMessage":"You've used 0% of your included API usage","autoBucketModels":["default"]}`

export const PLAN_FREE_RECORDED = `{"planInfo":{"planName":"Free","price":"Free","billingCycleEnd":"1795522358574"},"nextUpgrade":{"tier":"pro","name":"Pro","includedAmountCents":2000,"price":"$20/mo","description":"Upgrade to Cursor Pro","includedUsagePeriod":"INCLUDED_USAGE_PERIOD_MONTHLY"}}`

/**
 * NOT recorded: a paid plan's answer made by hand from the descriptor (`usage-contract.ts`) and the recorded Free one, until
 * an account on a paid plan is measured. 2000 cents included, 700 spent
 */
export const PERIOD_PAID_HAND_MADE = `{"billingCycleStart":"1792843958574","billingCycleEnd":"1795522358574","planUsage":{"totalSpend":700,"includedSpend":700,"remaining":1300,"limit":2000,"autoPercentUsed":20,"apiPercentUsed":61.5,"totalPercentUsed":35},"spendLimitUsage":{"individualLimit":0,"limitType":"user"},"enabled":true}`

export const PLAN_PAID_HAND_MADE = `{"planInfo":{"planName":"Pro","includedAmountCents":2000,"price":"$20/mo","billingCycleEnd":"1795522358574"}}`
