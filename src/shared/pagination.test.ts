import { parsePagination } from './pagination';

describe('safe pagination boundaries', () => {
  it('preserves defaults, integer strings and the existing maximum page size', () => {
    expect(parsePagination({})).toEqual({page:1,limit:20,offset:0});
    expect(parsePagination({page:'2',limit:'10'})).toEqual({page:2,limit:10,offset:10});
    expect(parsePagination({page:'2',limit:'500'})).toEqual({page:2,limit:100,offset:100});
  });
  it.each([
    {page:'1.5',limit:'2.5'}, {page:'1e308',limit:'100'}, {page:'0'}, {page:'-1'},
    {page:'invalid'}, {limit:'NaN'}, {limit:'0'}, {limit:[]}, {page:['1','2']},
    {page:{}}, {page:''}, {limit:' '}, {page:Number.MAX_SAFE_INTEGER,limit:100},
  ])('rejects non-integer, ambiguous or overflowing input %#', value => {
    expect(() => parsePagination(value)).toThrow(expect.objectContaining({statusCode:400,code:'VALIDATION_ERROR'}));
  });
});
