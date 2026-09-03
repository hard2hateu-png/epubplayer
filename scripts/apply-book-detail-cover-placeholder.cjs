const fs = require('fs')

const path = 'src/features/library/BookDetailPage.tsx'
let source = fs.readFileSync(path, 'utf8')

const oldBlock = `          <div className="mb-6 aspect-[2/3] w-48 flex-shrink-0 overflow-hidden rounded-2xl bg-surface-3 shadow-2xl md:mb-0 md:w-56">\n            {book.coverUrl ? (\n              <img src={book.coverUrl} alt={book.title} className="h-full w-full object-cover" />\n            ) : (\n              <div className="flex h-full w-full items-center justify-center bg-gradient-to-br from-surface-3 to-surface-4">\n                <span className="text-6xl opacity-50">📖</span>\n              </div>\n            )}\n          </div>`

const newBlock = `          <div className="relative mb-6 aspect-[2/3] w-48 flex-shrink-0 overflow-hidden rounded-2xl bg-surface-3 shadow-2xl md:mb-0 md:w-56">\n            {/* Keep a neutral placeholder underneath until the refreshed blob URL\n                has actually loaded. This prevents Safari from flashing its broken-image icon. */}\n            <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-surface-3 to-surface-4">\n              <span className="text-6xl opacity-50">📖</span>\n            </div>\n            {book.coverUrl && (\n              <img\n                src={book.coverUrl}\n                alt={book.title}\n                className="absolute inset-0 h-full w-full object-cover opacity-0 transition-opacity duration-150"\n                onLoad={(event) => {\n                  event.currentTarget.classList.remove('opacity-0')\n                  event.currentTarget.classList.add('opacity-100')\n                }}\n                onError={(event) => {\n                  event.currentTarget.classList.add('opacity-0')\n                  event.currentTarget.classList.remove('opacity-100')\n                }}\n              />\n            )}\n          </div>`

if (!source.includes(oldBlock)) {
  throw new Error('BookDetail cover block anchor not found')
}

source = source.replace(oldBlock, newBlock)
fs.writeFileSync(path, source)
console.log('Applied book-detail cover placeholder')
