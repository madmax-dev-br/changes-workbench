import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
export async function createFixture(root) {
  await fs.mkdir(root, { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    });
  const put = async (file, text) => {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), text);
  };
  git("init", "-b", "feature/flexible-checkout");
  git("config", "user.name", "Alex Morgan");
  git("config", "user.email", "alex@example.test");
  const kotlin = "app/src/main/kotlin/dev/checkout/";
  await put(".gitignore", ".gradle/\nbuild/\n");
  await put(
    "README.md",
    "# Checkout\n\nA small checkout service for the Workbench review fixture.\n",
  );
  await put(
    kotlin + "model/Order.kt",
    `package dev.checkout.model\n\n/** A customer order awaiting payment. */\ndata class Order(\n    val id: String,\n    val customerId: String,\n    val subtotal: Double,\n    val currency: String = "USD"\n)\n`,
  );
  await put(
    kotlin + "pricing/PriceCalculator.kt",
    `package dev.checkout.pricing\n\nimport dev.checkout.model.Order\n\n/** Calculates the final amount for an order. */\nclass PriceCalculator {\n    fun calculateTotal(order: Order): Double {\n        val tax = order.subtotal * 0.08\n        return order.subtotal + tax\n    }\n}\n`,
  );
  await put(
    kotlin + "pricing/LegacyDiscount.kt",
    `package dev.checkout.pricing\n\nclass LegacyDiscount {\n    fun apply(amount: Double) = amount * 0.95\n}\n`,
  );
  await put(
    kotlin + "pricing/DiscountStrategy.kt",
    `package dev.checkout.pricing\n\n/** Applies a promotional discount before tax. */\ninterface DiscountStrategy {\n    fun apply(amount: Double): Double\n}\n`,
  );
  await put(
    kotlin + "repository/OrderRepository.kt",
    `package dev.checkout.repository\n\nimport dev.checkout.model.Order\n\ninterface OrderRepository {\n    fun findById(id: String): Order?\n    fun save(order: Order)\n}\n`,
  );
  const checkout = `package dev.checkout.service\n\nimport dev.checkout.model.Order\nimport dev.checkout.pricing.PriceCalculator\nimport dev.checkout.repository.OrderRepository\nimport dev.checkout.payment.PaymentGateway\n\n/** Coordinates payment and order persistence. */\nclass CheckoutService(\n    private val orders: OrderRepository,\n    private val prices: PriceCalculator,\n    private val payments: PaymentGateway\n) {\n    /** Completes a checkout for the requested order. */\n    fun checkout(orderId: String): Receipt {\n        val order = orders.findById(orderId)\n            ?: error("Order not found: $orderId")\n\n        val total = prices.calculateTotal(order)\n        val paymentId = payments.charge(order.customerId, total)\n\n        return Receipt(order.id, paymentId, total)\n    }\n}\n\ndata class Receipt(\n    val orderId: String,\n    val paymentId: String,\n    val total: Double\n)\n`;
  await put(kotlin + "service/CheckoutService.kt", checkout);
  await put(
    "app/src/main/java/dev/checkout/payment/PaymentGateway.java",
    `package dev.checkout.payment;\n\n/** Connects the checkout flow to a payment provider. */\npublic interface PaymentGateway {\n    String charge(String customerId, double amount);\n}\n`,
  );
  git("add", ".");
  git("commit", "-m", "Introduce checkout services");
  git("config", "user.name", "Sam Rivera");
  git("config", "user.email", "sam@example.test");
  await put(
    kotlin + "service/CheckoutService.kt",
    checkout.replace(
      "val total = prices.calculateTotal(order)",
      "// Keep pricing in one place for every payment method.\n        val total = prices.calculateTotal(order)",
    ),
  );
  git("add", ".");
  git("commit", "-m", "Clarify checkout pricing responsibility");
  const current = checkout
    .replace(
      "fun checkout(orderId: String): Receipt {",
      "fun checkout(orderId: String, idempotencyKey: String): Receipt {",
    )
    .replace(
      "val total = prices.calculateTotal(order)",
      'require(order.subtotal > 0) { "Order total must be positive" }\n\n        val total = prices.calculateTotal(order)',
    )
    .replace(
      "payments.charge(order.customerId, total)",
      "payments.charge(order.customerId, total, idempotencyKey)",
    )
    .replace(
      "return Receipt(order.id, paymentId, total)",
      "orders.save(order)\n        return Receipt(order.id, paymentId, total, order.currency)",
    )
    .replace(
      "val total: Double\n",
      "val total: Double,\n    val currency: String\n",
    );
  await put(kotlin + "service/CheckoutService.kt", current);
  git("add", kotlin + "service/CheckoutService.kt");
  await put(
    kotlin + "service/CheckoutService.kt",
    current.replace(
      "orders.save(order)",
      "// Persist only after the payment has succeeded.\n        orders.save(order)",
    ),
  );
  await put(
    kotlin + "pricing/PriceCalculator.kt",
    `package dev.checkout.pricing\n\nimport dev.checkout.model.Order\n\n/** Calculates totals using the customer region and optional discounts. */\nclass PriceCalculator(\n    private val taxPolicy: TaxPolicy,\n    private val discount: DiscountPolicy? = null\n) {\n    fun calculateTotal(order: Order): Double {\n        val discounted = discount?.apply(order.subtotal) ?: order.subtotal\n        val tax = taxPolicy.rateFor(order.currency)\n        return discounted * (1 + tax)\n    }\n}\n`,
  );
  await put(
    kotlin + "pricing/TaxPolicy.kt",
    `package dev.checkout.pricing\n\n/** Regional tax rules, applied after discounts. */\nclass TaxPolicy {\n    fun rateFor(currency: String): Double = when (currency) {\n        "EUR" -> 0.20\n        "GBP" -> 0.20\n        else -> 0.08\n    }\n}\n`,
  );
  git(
    "mv",
    kotlin + "pricing/DiscountStrategy.kt",
    kotlin + "pricing/DiscountPolicy.kt",
  );
  await put(
    kotlin + "pricing/DiscountPolicy.kt",
    (
      await fs.readFile(
        path.join(root, kotlin + "pricing/DiscountPolicy.kt"),
        "utf8",
      )
    ).replaceAll("DiscountStrategy", "DiscountPolicy"),
  );
  git("add", kotlin + "pricing/DiscountPolicy.kt");
  await fs.unlink(path.join(root, kotlin + "pricing/LegacyDiscount.kt"));
  await put(
    kotlin + "model/Order.kt",
    (
      await fs.readFile(path.join(root, kotlin + "model/Order.kt"), "utf8")
    ).replace(
      'val currency: String = "USD"',
      'val currency: String = "USD",\n    val promoCode: String? = null',
    ),
  );
  await put(
    kotlin + "repository/OrderRepository.kt",
    (
      await fs.readFile(
        path.join(root, kotlin + "repository/OrderRepository.kt"),
        "utf8",
      )
    ).replace(
      "fun save(order: Order)",
      "/** Saves an order after a successful payment. */\n    fun save(order: Order)\n    fun findByCustomer(customerId: String): List<Order>",
    ),
  );
  await put(
    "app/src/main/java/dev/checkout/payment/PaymentGateway.java",
    `package dev.checkout.payment;\n\n/** Connects the checkout flow to a payment provider. */\npublic interface PaymentGateway {\n    /** Charges once for each idempotency key. */\n    String charge(String customerId, double amount, String idempotencyKey);\n}\n`,
  );
  await put(
    "README.md",
    "# Checkout\n\nA small checkout service for the Workbench review fixture.\n\n## Flexible checkout\n\nSupports regional tax, optional discounts and idempotent payments.\n",
  );
  return { root, kotlin, checkout: kotlin + "service/CheckoutService.kt" };
}
