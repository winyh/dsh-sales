import type { HandoffRoute } from './handoff-receive.js'

// Locally owned contract; no shared runtime package or cross-repository import.
export const handoffRoutes: Record<string, HandoffRoute> = {
  "product-sales-handoff": {
    "from": "dsh-product",
    "nextTool": "sales_product_handoff_review",
    "purpose": "接收价值证据与交付边界，再做销售资格和客户下一步审查。",
    "text": [
      "source",
      "productName",
      "targetBuyer",
      "customerProblem",
      "nextCustomerAction"
    ],
    "lists": [
      "valueEvidence",
      "proofPoints",
      "commercialContext"
    ],
    "mode": "direct"
  },
  "commercial-handoff": {
    "from": "dsh-business",
    "nextTool": "sales_commercial_handoff_review",
    "purpose": "接收价格底线、利润风险与待审批项，接收回执不是报价授权。",
    "text": [
      "source",
      "productName",
      "currency"
    ],
    "lists": [
      "offers",
      "requiredApprovals"
    ],
    "mode": "direct"
  },
  "product-feedback-closure": {
    "from": "dsh-product",
    "nextTool": "sales_win_loss_review",
    "purpose": "核对产品已处理的原反馈，再用后续客户结果检查问题是否减少，不自动联系客户。",
    "text": [
      "sourceArtifactId",
      "action",
      "owner",
      "evidence"
    ],
    "lists": [],
    "mode": "direct"
  }
}
