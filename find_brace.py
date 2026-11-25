import sys

def find_unbalanced(filepath):
    with open(filepath, 'r') as f:
        text = f.read()

    stack = []
    lines = text.split('\n')
    for i, line in enumerate(lines):
        if line.strip().startswith('//'):
            continue
        for j, char in enumerate(line):
            if char in '{[(':
                stack.append((char, i+1))
            elif char in '}])':
                if not stack:
                    print(f"Extra closing {char} on line {i+1}")
                    continue
                top = stack.pop()
                pairs = {'}': '{', ']': '[', ')': '('}
                if top[0] != pairs[char]:
                    print(f"Mismatch: expected {top[0]} to close, got {char} on line {i+1}. Open was on line {top[1]}")
    
    if stack:
        print(f"Unclosed braces in {filepath}:")
        for char, line in stack:
            print(f"  {char} on line {line}")
    else:
        print(f"All good in {filepath}")

find_unbalanced('src/index.ts')
find_unbalanced('src/checks.ts')
