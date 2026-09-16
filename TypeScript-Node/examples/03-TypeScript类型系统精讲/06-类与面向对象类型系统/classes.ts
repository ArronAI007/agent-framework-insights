// ===== abstract class：抽象类 + 两个具体子类 =====
// abstract class 不能被直接实例化（new Shape() 会编译报错），
// abstract 方法只声明签名、不给实现，强制每个子类必须提供自己的 area() 实现。
abstract class Shape {
	abstract area(): number;

	// 非 abstract 方法可以有默认实现，子类直接继承，不需要重写。
	describe(): string {
		return `${this.constructor.name} 的面积是 ${this.area().toFixed(2)}`;
	}
}

class Circle extends Shape {
	constructor(private readonly radius: number) {
		super();
	}

	area(): number {
		return Math.PI * this.radius ** 2;
	}
}

class Rectangle extends Shape {
	constructor(
		private readonly width: number,
		private readonly height: number,
	) {
		super();
	}

	area(): number {
		return this.width * this.height;
	}
}

// const shape = new Shape(); // 如果取消注释会编译报错：无法创建抽象类的实例
const shapes: Shape[] = [new Circle(2), new Rectangle(3, 4)];
for (const shape of shapes) {
	console.log(shape.describe());
}

// ===== 参数属性简写（parameter properties）=====
// 构造函数参数前加 public/private/protected/readonly，
// TS 会自动把它声明成同名的实例字段并完成赋值，不需要再手写 this.xxx = xxx。
class Point {
	// 等价于：先声明 readonly x: number; readonly y: number;
	// 再在 constructor 里写 this.x = x; this.y = y;
	constructor(
		public readonly x: number,
		public readonly y: number,
	) {}

	distanceTo(other: Point): number {
		return Math.sqrt((this.x - other.x) ** 2 + (this.y - other.y) ** 2);
	}
}

const origin = new Point(0, 0);
const target = new Point(3, 4);
console.log(`origin=(${origin.x}, ${origin.y}), target=(${target.x}, ${target.y})`);
console.log(`distance=${origin.distanceTo(target)}`);

// ===== private 字段 + getter：对外只暴露只读访问 =====
// #balance 是 JS 原生私有字段语法（不是 TS 的 private 修饰符，二者都能做到编译期
// 访问限制，但 # 字段在运行时也真正不可访问，即便绕过类型检查也拿不到）。
// 只通过 getter 暴露读取，不提供 setter，外部无法直接修改余额，
// 只能通过 deposit/withdraw 这些受控方法间接修改，保证内部不变量。
class BankAccount {
	#balance: number;

	constructor(initialBalance: number) {
		this.#balance = initialBalance;
	}

	get balance(): number {
		return this.#balance;
	}

	deposit(amount: number): void {
		if (amount <= 0) {
			throw new Error("存款金额必须为正数");
		}
		this.#balance += amount;
	}

	withdraw(amount: number): void {
		if (amount > this.#balance) {
			throw new Error("余额不足");
		}
		this.#balance -= amount;
	}
}

const account = new BankAccount(100);
account.deposit(50);
account.withdraw(30);
console.log(`account.balance=${account.balance}`);
// account.balance = 999; // 如果取消注释会编译报错：balance 只有 getter，没有 setter，是只读属性
// account.#balance; // 如果在类外部访问会编译报错：属性 "#balance" 在类 "BankAccount" 外部不可访问

// ===== implements vs extends：接口约束实现 vs 类继承实现 =====
// implements 只约束「必须提供这些方法/属性」，不提供任何实现代码，
// 一个类可以 implements 多个接口，但只能 extends 一个基类（TS 不支持多继承）。
interface Serializable {
	toJSON(): Record<string, unknown>;
}
interface Comparable<T> {
	compareTo(other: T): number;
}

class Money implements Serializable, Comparable<Money> {
	constructor(
		public readonly amount: number,
		public readonly currency: string,
	) {}

	toJSON(): Record<string, unknown> {
		return { amount: this.amount, currency: this.currency };
	}

	compareTo(other: Money): number {
		if (this.currency !== other.currency) {
			throw new Error(`无法比较不同币种：${this.currency} vs ${other.currency}`);
		}
		return this.amount - other.amount;
	}
}

const price1 = new Money(100, "CNY");
const price2 = new Money(150, "CNY");
console.log(`price1.toJSON()=${JSON.stringify(price1.toJSON())}`);
console.log(`price1.compareTo(price2)=${price1.compareTo(price2)}`);

// ===== static 成员：属于类本身，不属于任何实例 =====
class IdGenerator {
	// static 字段和方法通过类名直接访问（IdGenerator.next()），
	// 所有实例共享同一份状态，不需要先创建实例。
	static #counter = 0;

	static next(): number {
		IdGenerator.#counter += 1;
		return IdGenerator.#counter;
	}
}

console.log(`IdGenerator.next()=${IdGenerator.next()}`);
console.log(`IdGenerator.next()=${IdGenerator.next()}`);
console.log(`IdGenerator.next()=${IdGenerator.next()}`);
