/**
 * vitest 全局 setup
 *
 * 仅 import @testing-library/jest-dom 注入 expect 扩展。
 * 不做 mock；测试文件按需 vi.mock。
 */
import "@testing-library/jest-dom/vitest";
