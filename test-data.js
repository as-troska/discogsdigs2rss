// Mock data for testing when Discogs blocks requests
module.exports = [
  {
    id: 'test-1',
    title: 'The Evolution of Electronic Music: From Kraftwerk to Today',
    link: 'https://www.discogs.com/digs/test-1',
    description: 'Exploring the journey of electronic music through the decades and its impact on modern genres.',
    pubDate: new Date().toISOString(),
    imageUrl: 'https://via.placeholder.com/400x300',
    author: 'Discogs Editorial'
  },
  {
    id: 'test-2',
    title: 'Vinyl Collecting 101: A Beginner\'s Guide',
    link: 'https://www.discogs.com/digs/test-2',
    description: 'Everything you need to know about starting your vinyl collection, from storage to grading.',
    pubDate: new Date(Date.now() - 86400000).toISOString(),
    imageUrl: 'https://via.placeholder.com/400x300',
    author: 'Jane Smith'
  },
  {
    id: 'test-3',
    title: 'Jazz Legends: The Albums That Changed Everything',
    link: 'https://www.discogs.com/digs/test-3',
    description: 'A deep dive into the most influential jazz albums and the artists who created them.',
    pubDate: new Date(Date.now() - 172800000).toISOString(),
    imageUrl: 'https://via.placeholder.com/400x300',
    author: 'Mike Johnson'
  }
];
