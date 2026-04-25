# FIX-09 参考修复

## 根因

```python
return lines[-n - 1:]   # 取从倒数 n+1 个开始
```

`lines[-n-1:]` 实际是 `lines[-(n+1):]`，即从倒数 n+1 个元素开始切到末尾，共 **n+1** 个元素。

## 修复

```python
return lines[-n:]
```

`lines[-n:]` 取从倒数 n 个开始到末尾，正好 **n** 个元素。

## 验证

```python
lines = ["a", "b", "c", "d", "e"]
print(lines[-2:])      # ['d', 'e'] ✓
print(lines[-2 - 1:])  # ['c', 'd', 'e'] ✗
```

## 不要这么改

```python
# ❌ lines[-(n - 1):] —— 反而少取一个
# ❌ lines[len(lines) - n:] —— 等价但更繁琐
# ❌ 用 itertools.islice + reversed —— 杀鸡用牛刀
```
