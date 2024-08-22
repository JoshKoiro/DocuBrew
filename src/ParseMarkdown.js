(function(global) {
    class MarkdownConverter {
        constructor() {
            this.conversionFunctions = [
                this.convertImages,
                this.convertHeaders,
                this.convertBlockquotes,
                this.convertBoldText,
                this.convertItalicText,
                this.convertLinks,
                this.convertInlineCode,
                this.convertCodeBlocks,
                this.convertUnorderedLists,
                this.convertOrderedLists,
                this.convertHorizontalRules,
                this.convertLineBreaks
            ];
        }

        convertToHtml(markdown) {
            let html = markdown;
            this.conversionFunctions.forEach(func => {
                html = func(html);
            });
            html = this.wrapParagraphs(html);
            return html;
        }

        convertHeaders(text) {
            return text.replace(/^(#{1,6}) (.+)$/gm, (match, hashes, content) => {
                const level = hashes.length;
                return `<h${level}>${content.trim()}</h${level}>`;
            });
        }

        convertBlockquotes(text) {
            return text.replace(/^> (.+)/gm, '<blockquote>$1</blockquote>');
        }

        convertBoldText(text) {
            return text.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>');
        }

        convertItalicText(text) {
            return text.replace(/(\*|_)(.*?)\1/g, '<em>$2</em>');
        }

        convertLinks(text) {
            return text.replace(/(?<!!)\[([^\]]+)\]\(([^\)]+)\)/g, '<a href="$2">$1</a>');
        }

        convertImages(text) {
            return text.replace(/!\[([^\]]+)\]\(([^\)]+)\)/g, '<img src="$2" alt="$1">');
        }

        convertInlineCode(text) {
            return text.replace(/`(.*?)`/g, '<code>$1</code>');
        }

        convertCodeBlocks(text) {
            return text.replace(/```([\s\S]*?)```/g, (match, code) => {
                return `<pre><code>${this.escapeHtml(code.trim())}</code></pre>`;
            });
        }

        convertUnorderedLists(text) {
            let inList = false;
            let listHtml = '';
            
            return text.split('\n').map(line => {
                const match = line.match(/^(\s*)[\*\-\+]\s(.+)/);
                if (match) {
                    const [, indent, content] = match;
                    if (!inList) {
                        inList = true;
                        listHtml = '<ul>\n';
                    }
                    listHtml += `${indent}<li>${content}</li>\n`;
                    return null;  // We'll replace this line later
                } else if (inList && line.trim() === '') {
                    inList = false;
                    listHtml += '</ul>';
                    const result = listHtml;
                    listHtml = '';
                    return result;
                } else if (inList) {
                    inList = false;
                    listHtml += '</ul>';
                    const result = listHtml + '\n' + line;
                    listHtml = '';
                    return result;
                }
                return line;
            }).filter(line => line !== null).join('\n');
        }

        convertOrderedLists(text) {
            let inList = false;
            let listHtml = '';
            let lastNumber = 0;
            
            return text.split('\n').map(line => {
                const match = line.match(/^(\s*)(\d+)\.\s(.+)/);
                if (match) {
                    const [, indent, number, content] = match;
                    if (!inList || number === '1') {
                        if (inList) {
                            listHtml += '</ol>\n';
                        }
                        inList = true;
                        listHtml = '<ol>\n';
                        lastNumber = 1;
                    } else {
                        lastNumber++;
                    }
                    listHtml += `${indent}<li>${content}</li>\n`;
                    return null;  // We'll replace this line later
                } else if (inList && line.trim() === '') {
                    inList = false;
                    listHtml += '</ol>';
                    const result = listHtml;
                    listHtml = '';
                    return result;
                } else if (inList) {
                    inList = false;
                    listHtml += '</ol>';
                    const result = listHtml + '\n' + line;
                    listHtml = '';
                    return result;
                }
                return line;
            }).filter(line => line !== null).join('\n');
        }

        convertHorizontalRules(text) {
            return text.replace(/^(?:[\*\-_] *){3,}$/gm, '<hr />');
        }

        convertLineBreaks(text) {
            return text.replace(/^\s*$/gm, '<br />');
        }

        wrapParagraphs(html) {
            const paragraphs = html.split('\n\n');
            return paragraphs.map(p => {
                if (!p.startsWith('<')) {
                    return `<p>${p}</p>`;
                }
                return p;
            }).join('\n\n');
        }

        escapeHtml(unsafe) {
            return unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");
        }
    }

    // Make MarkdownConverter available globally
    global.MarkdownConverter = MarkdownConverter;

})(this);