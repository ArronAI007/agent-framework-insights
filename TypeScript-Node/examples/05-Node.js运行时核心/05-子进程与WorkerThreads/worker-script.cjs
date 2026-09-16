// ===== Worker 脚本：故意用纯 JS 的 .cjs，而不是 .ts =====
// worker_threads 启动新线程时，默认不会经过启动主线程用的 tsx 加载器——
// 主线程用 `npx tsx worker-main.ts` 启动时，tsx 只挂载了"当前这一个线程"的
// TS 转译钩子；new Worker() 创建的是一个全新的 V8 隔离环境（独立的线程），
// 并不会自动继承主线程注册的模块加载器。直接让 worker 跑一个纯 JS 的 .cjs 文件，
// 不涉及任何 TS 转译，是最省心、最不容易踩加载器配置坑的做法。
const { parentPort, workerData } = require("node:worker_threads");

// ===== parentPort.postMessage：worker 线程把结果发回主线程 =====
// workerData 是主线程创建 Worker 实例时传入的初始数据（这里是 { a, b } 两个数字），
// 每个 worker 线程都有自己独立的内存空间（不像浏览器的 SharedArrayBuffer 场景），
// 主线程和 worker 线程之间只能通过 postMessage 做结构化克隆式的消息传递来通信。
const { a, b } = workerData;
const sum = a + b;
parentPort.postMessage({ sum });
