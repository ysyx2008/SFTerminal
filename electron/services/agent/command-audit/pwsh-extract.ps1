# PowerShell 官方 AST 提取器（供 command-audit 静态审计）
# 参数：-PayloadB64（UTF-8 JSON {"command":"..."} 的 Base64）
# stdout: JSON { ok, calls[], writeRedirects[], errors[] }
param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadB64
)

$ErrorActionPreference = 'Stop'

function Test-DynamicAst($ast) {
  if ($null -eq $ast) { return $false }
  if ($ast -is [System.Management.Automation.Language.VariableExpressionAst]) { return $true }
  if ($ast -is [System.Management.Automation.Language.SubexpressionAst]) { return $true }
  if ($ast -is [System.Management.Automation.Language.ExpandableStringExpressionAst]) { return $true }
  if ($ast -is [System.Management.Automation.Language.IndexExpressionAst]) { return $true }
  if ($ast -is [System.Management.Automation.Language.MemberExpressionAst]) { return $true }
  if ($ast -is [System.Management.Automation.Language.InvokeMemberExpressionAst]) { return $true }
  if ($ast -is [System.Management.Automation.Language.ScriptBlockExpressionAst]) { return $true }
  if ($ast -is [System.Management.Automation.Language.CommandAst]) { return $true }
  if ($ast -is [System.Management.Automation.Language.UsingExpressionAst]) { return $true }
  return $false
}

function Get-StaticValue($ast) {
  if ($null -eq $ast) { return $null }
  if ($ast -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
    return $ast.Value
  }
  if ($ast -is [System.Management.Automation.Language.ConstantExpressionAst]) {
    return [string]$ast.Value
  }
  return $null
}

function Resolve-ArgumentValue($ast, [ref]$hasDynamic) {
  if (Test-DynamicAst $ast) {
    $hasDynamic.Value = $true
    return $null
  }
  $v = Get-StaticValue $ast
  if ($null -ne $v) { return $v }
  if ($ast -is [System.Management.Automation.Language.ArrayLiteralAst]) {
    $vals = @()
    foreach ($e in $ast.Elements) {
      $ev = Resolve-ArgumentValue $e ([ref]$hasDynamic)
      if ($null -ne $ev) {
        if ($ev -is [System.Array]) { $vals += $ev }
        else { $vals += $ev }
      }
    }
    if ($vals.Count -gt 0) { return ,$vals }
    return $null
  }
  return $null
}

function Add-Values($list, $value) {
  if ($null -eq $value) { return }
  if ($value -is [System.Array]) {
    foreach ($v in $value) { if ($null -ne $v -and "$v".Length -gt 0) { $list.Add("$v") } }
  } else {
    $list.Add("$value")
  }
}

$PathParamNames = [System.Collections.Generic.HashSet[string]]::new(
  [string[]]@(
    'Path', 'LiteralPath', 'Destination', 'Target', 'FilePath', 'OutFile', 'LogPath',
    'Include', 'Exclude', 'NewName', 'ItemType'
  ),
  [StringComparer]::OrdinalIgnoreCase
)

function Get-CommandName($cmdAst) {
  if ($cmdAst.InvocationOperator -ne [System.Management.Automation.Language.TokenKind]::Unknown) {
    return $null
  }
  if ($cmdAst.CommandElements.Count -eq 0) { return $null }
  $first = $cmdAst.CommandElements[0]
  if ($first -is [System.Management.Automation.Language.StringConstantExpressionAst]) {
    return $first.Value.ToLowerInvariant()
  }
  return $null
}

function Convert-Redirects($redirections, $writeRedirects) {
  $result = @()
  if ($null -eq $redirections) { return $result }
  foreach ($redir in $redirections) {
    if ($redir -is [System.Management.Automation.Language.FileRedirectionAst]) {
      $hasDyn = $false
      $target = Resolve-ArgumentValue $redir.Location ([ref]$hasDyn)
      if ($hasDyn -or $null -eq $target) { continue }
      $op = if ($redir.Append) { '>>' } else { '>' }
      $entry = @{
        op = $op
        target = "$target"
        isWrite = $true
      }
      $result += $entry
      $null = $writeRedirects.Add($entry)
    }
  }
  return $result
}

function Convert-CommandAst($cmdAst, [string]$rawExtent, $writeRedirects) {
  $flags = [System.Collections.Generic.List[string]]::new()
  $paths = [System.Collections.Generic.List[string]]::new()
  $args = [System.Collections.Generic.List[string]]::new()
  $dynamic = $false
  $cmdName = Get-CommandName $cmdAst
  if ($null -eq $cmdName) {
    $dynamic = $true
    $cmdName = 'unknown'
  }

  for ($i = 1; $i -lt $cmdAst.CommandElements.Count; $i++) {
    $el = $cmdAst.CommandElements[$i]
    if ($el -is [System.Management.Automation.Language.CommandParameterAst]) {
      $flags.Add('-' + $el.ParameterName)
      if ($null -eq $el.ArgumentList -or $el.ArgumentList.Count -eq 0) { continue }
      foreach ($arg in $el.ArgumentList) {
        $hasDyn = $false
        $val = Resolve-ArgumentValue $arg ([ref]$hasDyn)
        if ($hasDyn) { $dynamic = $true }
        if ($PathParamNames.Contains($el.ParameterName)) {
          Add-Values $paths $val
        } else {
          Add-Values $args $val
        }
      }
    } else {
      $hasDyn = $false
      $val = Resolve-ArgumentValue $el ([ref]$hasDyn)
      if ($hasDyn) { $dynamic = $true }
      elseif ($null -ne $val -and "$val" -match '^-{1,2}') {
        $flags.Add("$val")
      }
      elseif ($null -ne $val) {
        Add-Values $paths $val
      }
    }
  }

  return @{
    raw = $rawExtent
    cmd = $cmdName
    flags = @($flags)
    paths = @($paths)
    args = @($args)
    redirects = @()
    dynamicPaths = $dynamic
  }
}

function Collect-FromCommandExpression($exprAst, $writeRedirects, $calls) {
  if ($null -eq $exprAst) { return }
  $redirects = Convert-Redirects $exprAst.Redirections $writeRedirects
  if ($exprAst.Expression -is [System.Management.Automation.Language.CommandAst]) {
    $call = Convert-CommandAst $exprAst.Expression $exprAst.Extent.Text $writeRedirects
    if ($redirects.Count -gt 0) { $call.redirects = $redirects }
    $null = $calls.Add($call)
  }
}

function Collect-FromStatement($stmt, $writeRedirects, $calls) {
  if ($stmt -is [System.Management.Automation.Language.PipelineAst]) {
    foreach ($pe in $stmt.PipelineElements) {
      if ($pe -is [System.Management.Automation.Language.CommandExpressionAst]) {
        Collect-FromCommandExpression $pe $writeRedirects $calls
      } elseif ($pe -is [System.Management.Automation.Language.CommandAst]) {
        $null = $calls.Add((Convert-CommandAst $pe $pe.Extent.Text $writeRedirects))
      }
    }
    return
  }
  if ($stmt -is [System.Management.Automation.Language.CommandExpressionAst]) {
    Collect-FromCommandExpression $stmt $writeRedirects $calls
  } elseif ($stmt -is [System.Management.Automation.Language.CommandAst]) {
    $null = $calls.Add((Convert-CommandAst $stmt $stmt.Extent.Text $writeRedirects))
  }
}

try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PayloadB64))
  $input = $json | ConvertFrom-Json
  $code = [string]$input.command

  $tokens = $null
  $parseErrors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseInput($code, [ref]$tokens, [ref]$parseErrors)

  $calls = [System.Collections.Generic.List[object]]::new()
  $writeRedirects = [System.Collections.Generic.List[object]]::new()

  foreach ($stmt in $ast.EndBlock.Statements) {
    Collect-FromStatement $stmt $writeRedirects $calls
  }

  $errors = @()
  if ($null -ne $parseErrors) {
    foreach ($e in $parseErrors) { $errors += $e.Message }
  }

  $ok = ($calls.Count -gt 0) -or ($errors.Count -eq 0)

  @{
    ok = $ok
    calls = @($calls)
    writeRedirects = @($writeRedirects)
    errors = $errors
  } | ConvertTo-Json -Depth 8 -Compress
} catch {
  @{
    ok = $false
    calls = @()
    writeRedirects = @()
    errors = @($_.Exception.Message)
  } | ConvertTo-Json -Depth 8 -Compress
  exit 1
}
