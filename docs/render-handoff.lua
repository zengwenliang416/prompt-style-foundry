-- GOAL.md lives one directory above the other inputs and the HTML output.
function Link(link)
  link.target = link.target:gsub("^docs/", "")
  return link
end
